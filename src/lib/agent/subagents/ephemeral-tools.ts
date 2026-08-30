import "server-only";
import type { AssistantTool, ToolGateConfig } from "@/lib/assistant/tools";
import type { Agent } from "./types";
import * as vfs from "@/os/vfs";
import { withFeatureScope } from "@/lib/specs/feature-context";

// ADR-12 (Workflow Manager service-tools) — headless ephemeral tool fidelity.
//
// A headless (`runLocalHeadless`) agent has NO browser to dispatch a
// frontend-execution tool to: `awaitFrontendResult` is hard-wired to
// `{kind:"timeout"}`, so a frontend tool an ephemeral agent declares (e.g.
// `file_read`/`file_write`) would just time out and the agent would not
// "genuinely have" it. This module (a) bridges the declared frontend VFS tools
// to direct server-side VFS calls, and (b) computes the per-run gate that
// honors an ephemeral agent's declared `deferredTools` so `find_tools` can
// discover them.
//
// Everything here is keyed on `agent.ephemeral`; a NAMED agent takes the exact
// pre-patch path (unbridged tools, empty deferred set) so its behavior is
// byte-identical (design.md §9.8 risk #1 — the highest blast-radius surface).

/** Build a server-side VFS-bridge version of a frontend file_* tool. The I/O
 *  shape mirrors the browser handler in FrontendToolsV2.tsx exactly. The VFS op
 *  is bound to the calling conversation's feature scope so a write under a
 *  branch-coupled mount (/Specs, /Docs) resolves the same way the frontend and
 *  the server file_* tools do; a genuinely headless caller (no conversation)
 *  resolves no branch and hits the plain VFS. */
function vfsBridge(name: string, base: AssistantTool, run: (input: Record<string, unknown>) => Promise<string>): AssistantTool {
  return {
    name: base.name,
    description: base.description,
    parameters: base.parameters,
    execution: "server",
    ...(base.parallelSafe ? { parallelSafe: true as const } : {}),
    execute: async (input, ctx) => {
      try {
        return await withFeatureScope({ conversationId: ctx.conversationId }, () => run(input ?? {}));
      } catch (e) {
        return `Error: ${name}: ${(e as Error).message}`;
      }
    },
  };
}

/** The frontend file_* tools that have a direct server-side VFS equivalent.
 *  Only these are bridged; any other declared frontend tool (bos_app_launch,
 *  web_view, app_install, …) has no server equivalent and stays frontend
 *  (filtered out of the headless allowlist, as before). */
const EPHEMERAL_VFS_BRIDGES: Record<string, (base: AssistantTool) => AssistantTool> = {
  file_list: (base) =>
    vfsBridge(
      base.name,
      base,
      async (input) => {
        const path = String(input.path ?? "") || "/";
        const entries = await vfs.list(path);
        return JSON.stringify(entries.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size })));
      },
    ),
  file_read: (base) =>
    vfsBridge(base.name, base, async (input) => {
      const path = String(input.path ?? "");
      return vfs.readText(path);
    }),
  file_write: (base) =>
    vfsBridge(base.name, base, async (input) => {
      const path = String(input.path ?? "");
      const content = String(input.content ?? "");
      await vfs.writeText(path, content);
      return `Wrote ${path}.`;
    }),
  file_mkdir: (base) =>
    vfsBridge(base.name, base, async (input) => {
      const path = String(input.path ?? "");
      await vfs.mkdir(path);
      return `Created folder ${path}.`;
    }),
  file_delete: (base) =>
    vfsBridge(base.name, base, async (input) => {
      const path = String(input.path ?? "");
      await vfs.remove(path);
      return `Deleted ${path}.`;
    }),
  file_rename: (base) =>
    vfsBridge(base.name, base, async (input) => {
      const path = String(input.path ?? "");
      const to = String(input.to ?? "");
      await vfs.rename(path, to);
      return `Renamed ${path} to ${to}.`;
    }),
};

/** For an EPHEMERAL agent, replace the frontend-execution VFS tools it DECLARED
 *  with server-side VFS-bridge implementations, so the headless loop can run
 *  them. Returns a shallow copy (only bridged entries replaced); returns the
 *  original object untouched when nothing is bridged. */
export function bridgeEphemeralFrontendTools(
  tools: Record<string, AssistantTool>,
  declared?: string[],
): Record<string, AssistantTool> {
  if (!declared?.length) return tools;
  const declaredSet = new Set(declared);
  let bridged: Record<string, AssistantTool> | undefined;
  for (const [name, tool] of Object.entries(tools)) {
    if (tool.execution !== "frontend" || !declaredSet.has(name)) continue;
    const bridge = EPHEMERAL_VFS_BRIDGES[name];
    if (!bridge) continue;
    (bridged ??= { ...tools })[name] = bridge(tool);
  }
  return bridged ?? tools;
}

/** The per-run gate for a headless (`runLocalHeadless`) agent. `tools` is the
 *  EFFECTIVE tool map the run executes against (already bridged for an ephemeral
 *  agent — see `bridgeEphemeralFrontendTools`):
 *
 *  - `allow` is the base allowlist filtered to server-executable tools — for an
 *    ephemeral agent that runs against the bridged tools, so a declared frontend
 *    VFS tool (now `execution:"server"`) is included and actually executable.
 *  - `deferred`: an ephemeral agent honors its DECLARED `deferredTools` (so
 *    `find_tools` can discover them — FR-034); a named agent keeps the empty
 *    set (headless = always fully visible, no discovery round-trip) exactly as
 *    before.
 *
 *  For a named agent this returns a gate byte-identical to the pre-patch inline
 *  formula (unbridged tools, empty deferred). */
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
