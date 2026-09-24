import "server-only";

// 035-spec-promote-conflict-escalation (FR-025) — WHICH agent resolves a
// conflict, in one place.
//
// Shared by the escalation (`reconcile.ts`) and the retry path
// (`sessions/store.ts`) so both read the SAME configured value. That sharing is
// the point: before it, the agent was resolved once, at escalation, and frozen
// onto the session — so escalating to a mis-configured agent left the session
// with no way forward except abandoning it and redoing the whole operation.

/** The pre-035 hard-coded conflict agent, and the fallback when nothing is
 *  configured — keeping the source-repo path byte-identical (FR-023). */
export const DEVOPS_AGENT_ID = "devops";

/** The currently configured conflict-resolution agent, read fresh on every
 *  call so a change in Settings → Build Studio takes effect with no reload. */
export async function conflictAgentId(): Promise<string> {
  // Dynamic import: `@/lib/config/registry` pulls in the entire settings
  // surface, and this module is reached from the session store — which the
  // assistant tool registry already imports. Keeping config out of the static
  // graph keeps that edge acyclic, the same discipline `store.ts` uses for
  // `start-run.ts`.
  const { getConfigValue } = await import("@/lib/config/registry");
  const configured = await getConfigValue("build-studio", "conflictAgent").catch(() => undefined);
  return typeof configured === "string" && configured.trim() ? configured.trim() : DEVOPS_AGENT_ID;
}
