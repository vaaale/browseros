import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  RENDER_A2UI_TOOL_DEF,
  BASIC_CATALOG_ID,
  buildSubagentPrompt,
  runA2UIGenerationWithRecovery,
  assembleOps,
  wrapAsOperationsEnvelope,
  wrapErrorEnvelope,
} from "@ag-ui/a2ui-toolkit";
import type { AssistantTool, ToolContext } from "../../tools";
import { serverTool, schema, p } from "./util";
import { getProviderConfig, DEFAULT_MAX_TOKENS } from "@/lib/agent/provider";
import { familyOf, normalizeApiBase } from "@/lib/agent/provider-meta";

// a2ui_render (013-build-studio-agentic V2): a server tool that runs a
// constrained sub-agent to produce a validated A2UI v0.9 operations envelope,
// which the calling agent then pushes to the UI Preview app via
// ui_preview_render. Uses @ag-ui/a2ui-toolkit's framework-agnostic prompt +
// validation/recovery helpers with BOS's own configured provider/model — not
// the toolkit's AG-UI-coupled `prepareA2UIRequest`/`findPriorSurface`, which
// assume AG-UI's RunAgentInput state/message shape that BOS's tool loop
// doesn't produce. Continuity across "update" iterations is therefore the
// calling agent's job: describe what already exists in `description` when
// revising a surface, the same way any other tool call carries its own context.

const DEFAULT_SURFACE_ID = "dynamic-surface";
const RENDER_TOOL = RENDER_A2UI_TOOL_DEF.function;

// The basic catalog's component names (src/apps/ui-preview renders via
// `@copilotkit/a2ui-renderer`'s basicCatalog — kept in sync with
// react-renderer/a2ui-react/catalog/basic/index in that package).
const BASIC_CATALOG_COMPONENTS =
  "Text, Image, Icon, Video, AudioPlayer, Row, Column, List, Card, Tabs, Divider, Modal, Button, TextField, CheckBox, ChoicePicker, Slider, DateTimeInput";

const BOS_DESIGN_CONTEXT = `## Available components (A2UI v0.9 basic catalog)
${BASIC_CATALOG_COMPONENTS}

Do not invent components outside this list.

## BOS design constraints
- Dark theme only — assume a dark host background.
- Dense UI: prefer compact spacing over generous whitespace.
- Keep the same surfaceId across iterations of the same design so updates replace it in place.`;

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

async function renderA2UI(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const intent = input.intent === "update" ? "update" : "create";
  const description = String(input.description ?? "").trim();
  if (!description) return wrapErrorEnvelope("No description provided.");
  const surfaceId = String(input.surfaceId ?? "").trim() || DEFAULT_SURFACE_ID;

  const basePrompt = buildSubagentPrompt({
    contextPrompt: `${BOS_DESIGN_CONTEXT}\n\n## Request\nSurface id: ${surfaceId}\nIntent: ${intent}\n${description}`,
  });

  const result = await runA2UIGenerationWithRecovery({
    basePrompt,
    invokeSubagent: (prompt) => invokeSubagent(prompt, ctx.signal),
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
  return result.envelope;
}

export function a2uiRenderTools(): Record<string, AssistantTool> {
  return {
    a2ui_render: serverTool(
      "a2ui_render",
      "Generate a validated A2UI v0.9 operations envelope for the UI Preview app from a natural-language description. Call during the design-UI phase of a bos-app session, then pass the returned envelope's surfaceId/operations straight to ui_preview_render (do not hand-edit it). Use intent='update' with the SAME surfaceId to revise a surface already rendered in this conversation — describe what already exists and what should change, since this tool does not see prior renders itself.",
      schema(
        {
          intent: p.str("'create' for a new surface (default) or 'update' to revise one."),
          surfaceId: p.str("Surface id. Reuse the same id across iterations of one design; omit on the first create for a generated id."),
          description: p.str("Natural-language description of the UI to render, or of the changes to apply on an update."),
        },
        ["description"],
      ),
      renderA2UI,
    ),
  };
}
