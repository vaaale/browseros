import "server-only";
import { wrapLanguageModel, type LanguageModel } from "ai";
import type { LanguageModelV3, LanguageModelV3Middleware } from "@ai-sdk/provider";
import { CAPABILITIES, deferredCapabilityIds } from "@/lib/agent/capabilities-registry";

// Server-side tool gate for the main agent (025-deferred-tool-discovery +
// 016-unified-agents). This is the SINGLE choke point that decides which tools
// the model may see on any given step — mirroring what the sub-agent tool loop
// (src/lib/agent/llm.ts) does per iteration. All frontend actions are registered
// plainly on the client; visibility is filtered here at the model boundary.
//
// Two gates, applied to registry capabilities only (consent / AGUI / discovery
// actions are never in the registry, so they always pass):
//   1. ALLOWLIST (016): a capability is offered only if it is in the agent's
//      `tools` set. Empty/undefined allowlist ⇒ zero registry tools (matches
//      toolsFor()), leaving just the always-available discovery + consent tools.
//   2. DEFERRED (025): a capability in the effective deferred set
//      (registry defaults ∪ agent.deferredTools) is hidden until it has been
//      revealed by a prior find_tools call IN THIS CONVERSATION. The revealed
//      set is derived statelessly from the message history (find_tools tool
//      results), so it needs no store and is always in sync with the transcript.
//
// Description overrides (Settings → Tools) are applied here too, so the model
// sees the user's edited description without any client involvement.

const DISCOVERY_TOOLS = new Set(["find_tools", "find_agent"]);
const REGISTRY_IDS = new Set(CAPABILITIES.map((c) => c.id));

export interface ToolGateOptions {
  /** The agent's `tools` allowlist. Empty ⇒ zero registry tools. */
  allow: string[];
  /** The agent's per-agent deferred additions (unioned with registry defaults). */
  deferredTools: string[];
  /** Description overrides keyed by capability id (Settings → Tools). */
  descriptions: Record<string, string | undefined>;
}

type ToolResultPart = { type?: string; toolName?: string; output?: { type?: string; value?: unknown } };
type PromptMessage = { content?: unknown };

function parseMaybeJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Extract the tool ids revealed by every prior find_tools result in the
 *  message history. find_tools returns a JSON array of `{ id, … }`; we collect
 *  each `id`. Robust to text- or json-typed tool outputs and to malformed
 *  payloads (skipped silently). */
export function deriveRevealedIds(prompt: unknown): Set<string> {
  const revealed = new Set<string>();
  if (!Array.isArray(prompt)) return revealed;
  for (const msg of prompt as PromptMessage[]) {
    if (!Array.isArray(msg?.content)) continue;
    for (const part of msg.content as ToolResultPart[]) {
      if (part?.type !== "tool-result" || part.toolName !== "find_tools") continue;
      const out = part.output;
      let payload: unknown;
      if (out?.type === "json") payload = parseMaybeJsonString(out.value);
      else if (out?.type === "text") payload = parseMaybeJsonString(out.value);
      else continue;
      if (!Array.isArray(payload)) continue;
      for (const r of payload) {
        const id = (r as { id?: unknown })?.id;
        if (typeof id === "string" && id) revealed.add(id);
      }
    }
  }
  return revealed;
}

function isWrappableModel(model: LanguageModel): model is LanguageModelV3 {
  if (!model || typeof model !== "object") return false;
  const cand = model as { specificationVersion?: unknown; doGenerate?: unknown };
  return cand.specificationVersion === "v3" && typeof cand.doGenerate === "function";
}

/** Wrap a v3 language model so the model only ever sees the tools the agent is
 *  allowed to use and that are either non-deferred or already revealed in this
 *  conversation. Non-v3 models (e.g. a raw model-id string) pass through. */
export function withToolGate(model: LanguageModel, opts: ToolGateOptions): LanguageModel {
  if (!isWrappableModel(model)) return model;

  const allowSet = new Set(opts.allow);
  const deferred = new Set<string>([...deferredCapabilityIds(), ...opts.deferredTools]);
  const { descriptions } = opts;

  const middleware: LanguageModelV3Middleware = {
    specificationVersion: "v3",
    transformParams: async ({ params }) => {
      const tools = params.tools;
      if (!Array.isArray(tools) || tools.length === 0) return params;

      const revealed = deriveRevealedIds(params.prompt);

      const filtered = tools.filter((t) => {
        const name = (t as { name?: string }).name;
        if (!name) return true;
        // Always-available: discovery + anything not in the capability registry
        // (consent, elicitation, AGUI state tools, …).
        if (DISCOVERY_TOOLS.has(name) || !REGISTRY_IDS.has(name)) return true;
        // Allowlist gate (016).
        if (!allowSet.has(name)) return false;
        // Deferred gate (025).
        if (deferred.has(name) && !revealed.has(name)) return false;
        return true;
      });

      // Apply description overrides (Settings → Tools) to the surviving tools.
      const withDescriptions = filtered.map((t) => {
        const name = (t as { name?: string }).name;
        const override = name ? descriptions[name] : undefined;
        if (override && override !== (t as { description?: string }).description) {
          return { ...t, description: override };
        }
        return t;
      });

      return { ...params, tools: withDescriptions } as typeof params;
    },
  };

  return wrapLanguageModel({ model, middleware });
}
