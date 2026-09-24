import "server-only";
import type { AssistantTool, ToolGateConfig } from "@/lib/assistant/tools";
import type { Agent } from "./types";

// The per-run tool gate for a headless (`runLocalHeadless`) agent.
//
// HISTORY, because the shape only makes sense with it. ADR-12 (Workflow Manager
// service-tools) added this module for two jobs: computing the headless gate,
// and BRIDGING an ephemeral agent's declared frontend VFS tools
// (file_read/file_write/…) to direct server-side VFS calls, because a headless
// run has no browser to dispatch a frontend tool to — `awaitFrontendResult` is
// hard-wired to `{kind:"timeout"}`, so such a tool would simply hang and the
// agent would not "genuinely have" it.
//
// That bridge is gone. It was keyed on `agent.ephemeral`, which left the same
// hole open for every headless NAMED agent: Build Studio and the self-heal
// spine could not create a file at all, while `find_tools` — reading the
// persisted AGENT.md rather than the enforced gate — went on advertising
// file_write as available. One production run spent 2.3 hours and 69 tool calls
// reaching for it (EHS-0026). The six VFS CRUD tools are ordinary server tools
// now (src/lib/assistant/tools/server/files.ts), so `allow`'s server-executable
// filter below simply keeps them, for named and ephemeral agents alike, and no
// bridge is needed for either. See docs/dev/file-tools/file-tools.md.

/** The per-run gate for a headless agent. `tools` is the EFFECTIVE tool map the
 *  run executes against.
 *
 *  - `allow` is the base allowlist filtered to server-executable tools. A
 *    genuinely frontend-only tool (bos_app_launch, web_view, the ui_preview
 *    family) has no server implementation and is correctly dropped: there is no
 *    browser to run it in, and offering it would be the deception this filter
 *    exists to prevent.
 *  - `deferred`: an ephemeral agent honors its DECLARED `deferredTools` (so
 *    `find_tools` can discover them — FR-034); a named agent keeps the empty
 *    set (headless = always fully visible, no discovery round-trip). */
export function headlessGate(
  agent: Agent,
  tools: Record<string, AssistantTool>,
  baseGate: ToolGateConfig,
): ToolGateConfig {
  return {
    allow: new Set([...baseGate.allow].filter((id) => tools[id]?.execution === "server")),
    deferred: agent.ephemeral ? baseGate.deferred : new Set<string>(),
    registryIds: baseGate.registryIds,
    descriptions: baseGate.descriptions,
  };
}
