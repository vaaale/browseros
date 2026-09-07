// Tool-state classification for the Assistant Info Panel's Tools tab
// (042-tool-color-coding). Framework-free — no React, no `server-only`, no Node
// APIs — so the client component, the server, and the hand-run test all import
// the SAME predicate.
//
// The point of this module is that the panel's colours can never disagree with
// what the agent can actually call: it consumes exactly the three sources the
// run uses.
//
//   allow     ← the selected agent's `tools`        (run: gate.ts `allow`)
//   deferred  ← the selected agent's `deferredTools` (run: gate.ts `deferred`)
//   revealed  ← `deriveRevealedIds(messages)` from `@/lib/assistant/messages`
//               (run: agent-loop.ts calls that exact function)
//
// The revealed set MUST come from `src/lib/assistant/messages.ts` — the
// client-safe, zero-import version that reads the persisted `ChatMessage[]`
// shape. There is a second function of the same name in
// `src/lib/agent/tool-gate.ts`; that one is `import "server-only"` and reads
// the in-memory model-prompt shape, so it is neither importable from the client
// nor fed the right input here.

/** The four visual states a tool row can be in. `neutral` is the absence of a
 *  state (today's grey), not a fifth colour. */
export type ToolState = "granted" | "deferredHidden" | "deferredRevealed" | "neutral";

/** Always-available discovery tools — they bypass the allowlist entirely, so
 *  colouring them "granted" would misrepresent the gate.
 *
 *  Mirrored (not imported) from its two server-side twins, neither of which is
 *  reachable from a framework-free client module: `DISCOVERY_TOOLS` in
 *  `src/lib/assistant/tools.ts` (module-private) and `ALWAYS_AVAILABLE` in
 *  `src/lib/assistant/gate.ts` (`import "server-only"`).
 *
 *  This is defensive: neither id is in the capability registry, so
 *  `assistantToolsManifest()` never emits a row for them today. */
export const DISCOVERY_TOOL_IDS: ReadonlySet<string> = new Set(["find_tools", "find_agent"]);

export interface ToolStateContext {
  /** The selected agent's allowlist. Empty ⇒ zero granted (strict membership —
   *  NOT the lenient "empty means all" the Skills/MCP tabs use). */
  allow: ReadonlySet<string>;
  /** The selected agent's deferred set. Deferral is a sub-state of granted. */
  deferred: ReadonlySet<string>;
  /** Tool ids revealed by a prior `find_tools` result in THIS conversation. */
  revealed: ReadonlySet<string>;
  /** `DISCOVERY_TOOL_IDS.has(toolId)` — computed by the caller so this function
   *  stays a pure predicate over sets. */
  isDiscovery: boolean;
}

/**
 * Classify one tool row. Predicate order is normative:
 *
 *   1. discovery                       → neutral (bypasses the allowlist)
 *   2. not allowed                     → neutral (incl. the empty allowlist)
 *   3. deferred AND revealed           → deferredRevealed (blue)
 *   4. deferred                        → deferredHidden   (orange)
 *   5. otherwise                       → granted          (green)
 *
 * Steps 3–5 are only reached once the tool is granted, so "granted" is the
 * implicit precondition for every coloured state. Neutral first means a
 * revealed-but-not-granted tool is neutral, never blue; blue before orange
 * means a revealed deferred tool is blue, never orange.
 */
export function classifyToolState(toolId: string, ctx: ToolStateContext): ToolState {
  if (ctx.isDiscovery) return "neutral";
  if (!ctx.allow.has(toolId)) return "neutral";
  if (ctx.deferred.has(toolId)) return ctx.revealed.has(toolId) ? "deferredRevealed" : "deferredHidden";
  return "granted";
}
