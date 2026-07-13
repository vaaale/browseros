import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  RENDER_A2UI_TOOL_DEF,
  BASIC_CATALOG_ID,
  A2UI_OPERATIONS_KEY,
  buildSubagentPrompt,
  runA2UIGenerationWithRecovery,
  assembleOps,
  wrapAsOperationsEnvelope,
} from "@ag-ui/a2ui-toolkit";
import { getProviderConfig, DEFAULT_MAX_TOKENS } from "@/lib/agent/provider";
import { familyOf, normalizeApiBase } from "@/lib/agent/provider-meta";
import { describeCatalogForPrompt } from "@/apps/ui-preview/catalog-schema";

// A2UI generation service (025-ui-preview-a2ui-tools). Extracted from the old
// `a2ui_render` tool: the LLM-driven generation of a validated A2UI v0.9
// operations envelope from a natural-language description, now consumed via an
// API route by the UI Preview app's `ui_preview_generate`/`ui_preview_patch`
// frontend tools (which generate AND render in one step) instead of being a
// standalone agent-visible tool that the model had to remember to chain into
// `ui_preview_render`. Uses @ag-ui/a2ui-toolkit's framework-agnostic prompt +
// validation/recovery helpers with BOS's own configured provider/model.

export const A2UI_DEFAULT_SURFACE_ID = "dynamic-surface";
const RENDER_TOOL = RENDER_A2UI_TOOL_DEF.function;

/** A component in the current surface state, shaped like an A2UI operation
 *  component (`{ id, component, ...props }`) — the same shape the sub-agent
 *  emits, so a patch request can reference existing ids directly. */
export interface A2UIComponentSnapshot {
  id: string;
  component: string;
  [key: string]: unknown;
}

export interface A2UIGenerationResult {
  ok: boolean;
  surfaceId: string;
  operations: Record<string, unknown>[];
  error?: string;
}

// Full per-component prop schema derived at call time from the SAME zod schemas
// src/apps/ui-preview/catalog.tsx renders with — see catalog-schema.ts.
function bosDesignContext(): string {
  return `## Available components (A2UI v0.9 basic catalog)
Use ONLY the components below — do not invent others. Each field is shown as
\`name: type\` (or \`name?: type\` if optional) with its real meaning. Any field
may ALSO be bound to live data via \`{"path": "/some/pointer"}\` or a function
call via \`{"call": "name", "args": {...}}\` instead of a literal value — but for
a static mockup, just pass literal values as shown.

${describeCatalogForPrompt()}

## Interactivity (make the mockup actually work, not just look right)
The surface has a reactive DATA MODEL: components can WRITE values to a path and
READ them back, so clicks and inputs have real effect with no server round-trip.
Use these patterns whenever the request implies interaction:
- **Inputs hold state**: give every TextField / CheckBox / Slider / ChoicePicker /
  DateTimeInput a \`value\` bound to a data path, e.g. \`"value": {"path": "/form/email"}\`
  (NOT a literal). Then the field remembers what the user enters and other
  components can show it.
- **Single choice (radio) / multi-select**: use a ChoicePicker with
  \`"variant": "mutuallyExclusive"\` (single) and bind its \`value\` to a path
  (e.g. \`/plan\`). It already highlights the selected option on click — prefer it
  over hand-built clickable rows when the user is picking ONE of several options.
- **Buttons that change state**: give the Button an
  \`"action": {"event": {"name": "setData", "context": {"target": "/step", "value": 2}}}\`.
  Clicking it sets \`/step\` to 2 in the data model. (The data path key MUST be
  \`target\`, never \`path\` — \`path\` is reserved for read bindings.)
- **Show a live value** (summaries, confirmations): bind a Text's \`text\`
  directly to the path, e.g. \`"text": {"path": "/form/email"}\`. For a
  "Label: value" line, use a Row with a static label Text plus a second Text
  bound to the path.
- **Links**: a Button action \`{"event": {"name": "openUrl", "context": {"url": "https://…"}}}\`.
- **Tabs**: use the Tabs component for tabbed sections — clicking a tab header
  already switches its content.
Only "setData" and "openUrl" action names are handled; do not invent other
action names (they will do nothing).

## BOS design constraints
- Dark theme only — assume a dark host background.
- Dense UI: prefer compact spacing over generous whitespace.
- Keep the same surfaceId across iterations of the same design so updates replace it in place.`;
}

async function invokeSubagent(prompt: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  const c = await getProviderConfig();
  if (familyOf(c.provider) === "anthropic") {
    const client = new Anthropic({ apiKey: c.apiKey || "MISSING", baseURL: c.baseUrl || undefined });
    const res = await client.messages.create(
      {
        model: c.model,
        max_tokens: c.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: prompt,
        messages: [{ role: "user", content: "Generate the UI now." }],
        tools: [{ name: RENDER_TOOL.name, description: RENDER_TOOL.description, input_schema: RENDER_TOOL.parameters as Anthropic.Tool.InputSchema }],
        tool_choice: { type: "tool", name: RENDER_TOOL.name },
      },
      { signal },
    );
    const block = res.content.find((b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use");
    return (block?.input as Record<string, unknown>) ?? null;
  }
  const client = new OpenAI({ apiKey: c.apiKey || "local", baseURL: c.baseUrl ? normalizeApiBase(c.baseUrl) : undefined });
  const res = await client.chat.completions.create(
    {
      model: c.model,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: "Generate the UI now." },
      ],
      tools: [{ type: "function", function: { name: RENDER_TOOL.name, description: RENDER_TOOL.description, parameters: RENDER_TOOL.parameters } }],
      tool_choice: { type: "function", function: { name: RENDER_TOOL.name } },
    },
    { signal },
  );
  const call = res.choices[0]?.message?.tool_calls?.[0];
  if (!call || call.type !== "function") return null;
  try {
    return JSON.parse(call.function.arguments) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function currentStateBlock(surfaceId: string, components: A2UIComponentSnapshot[]): string {
  return `

## Current surface state
Surface "${surfaceId}" currently contains these components (each shown as its
\`{ id, component, ...props }\`). Apply the requested change by returning ONLY
the components that must change — do NOT re-send unchanged components:
- To CHANGE a component in place, return it with its EXISTING id and the new props.
- To ADD a component, return it with a NEW id AND return its parent with the new
  id inserted into the parent's \`children\` array (or \`child\`).
- To REMOVE a component, return its parent with that child's id omitted from the
  parent's \`children\`/\`child\`. Do not return the removed component itself.

${JSON.stringify(components, null, 2)}`;
}

// Deterministic e2e bypass: when BOS_E2E_SCRIPTED=1 and the description is an
// `@@e2e {"operations":[...]}` directive, return those operations verbatim
// without calling the LLM — the same convention e2e-provider.ts uses for model
// turns. This is what lets Playwright tests push a handcrafted envelope through
// ui_preview_generate deterministically (e.g. the catalog smoke test), now that
// there is no separate raw-operations tool.
const E2E_PREFIX = "@@e2e ";
function scriptedOperations(description: string): Record<string, unknown>[] | null {
  if (process.env.BOS_E2E_SCRIPTED !== "1") return null;
  if (!description.startsWith(E2E_PREFIX)) return null;
  try {
    const parsed = JSON.parse(description.slice(E2E_PREFIX.length)) as { operations?: unknown };
    return Array.isArray(parsed.operations) ? (parsed.operations as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

/** The surface id the given operations target (from any op payload carrying
 *  one), so a scripted render resolves to the same surface the ops build. */
function surfaceIdOf(operations: Record<string, unknown>[]): string | undefined {
  for (const op of operations) {
    for (const value of Object.values(op)) {
      if (value && typeof value === "object" && typeof (value as { surfaceId?: unknown }).surfaceId === "string") {
        return (value as { surfaceId: string }).surfaceId;
      }
    }
  }
  return undefined;
}

async function runGeneration(params: {
  intent: "create" | "update";
  description: string;
  surfaceId: string;
  currentComponents?: A2UIComponentSnapshot[];
  signal: AbortSignal;
}): Promise<A2UIGenerationResult> {
  const { intent, description, surfaceId, currentComponents, signal } = params;

  const scripted = scriptedOperations(description);
  if (scripted) return { ok: true, surfaceId: surfaceIdOf(scripted) ?? surfaceId, operations: scripted };

  const stateBlock = currentComponents?.length ? currentStateBlock(surfaceId, currentComponents) : "";
  const basePrompt = buildSubagentPrompt({
    contextPrompt: `${bosDesignContext()}\n\n## Request\nSurface id: ${surfaceId}\nIntent: ${intent}\n${description}${stateBlock}`,
  });

  const result = await runA2UIGenerationWithRecovery({
    basePrompt,
    invokeSubagent: (prompt) => invokeSubagent(prompt, signal),
    buildEnvelope: (args) =>
      wrapAsOperationsEnvelope(
        assembleOps({
          intent,
          surfaceId: String(args.surfaceId ?? surfaceId) || surfaceId,
          catalogId: BASIC_CATALOG_ID,
          components: Array.isArray(args.components) ? (args.components as Record<string, unknown>[]) : [],
          data: (args.data as Record<string, unknown>) ?? undefined,
        }),
      ),
  });

  if (!result.ok) {
    return { ok: false, surfaceId, operations: [], error: "The UI generator could not produce a valid design for that request. Try rephrasing or simplifying it." };
  }
  let operations: Record<string, unknown>[] = [];
  try {
    const parsed = JSON.parse(result.envelope) as Record<string, unknown>;
    const ops = parsed[A2UI_OPERATIONS_KEY];
    operations = Array.isArray(ops) ? (ops as Record<string, unknown>[]) : [];
  } catch {
    return { ok: false, surfaceId, operations: [], error: "The UI generator returned a malformed result." };
  }
  return { ok: true, surfaceId, operations };
}

/** Generate a fresh A2UI surface from a natural-language description. */
export function generateA2UI(params: { description: string; surfaceId?: string; signal: AbortSignal }): Promise<A2UIGenerationResult> {
  return runGeneration({
    intent: "create",
    description: params.description,
    surfaceId: params.surfaceId?.trim() || A2UI_DEFAULT_SURFACE_ID,
    signal: params.signal,
  });
}

/** Patch an already-rendered A2UI surface: the current component snapshot is
 *  supplied so the sub-agent can target real existing ids (add/replace in
 *  place / remove-by-omission) instead of relying on a prose description of
 *  what already exists. */
export function patchA2UI(params: {
  description: string;
  surfaceId?: string;
  currentComponents: A2UIComponentSnapshot[];
  signal: AbortSignal;
}): Promise<A2UIGenerationResult> {
  return runGeneration({
    intent: "update",
    description: params.description,
    surfaceId: params.surfaceId?.trim() || A2UI_DEFAULT_SURFACE_ID,
    currentComponents: params.currentComponents,
    signal: params.signal,
  });
}
