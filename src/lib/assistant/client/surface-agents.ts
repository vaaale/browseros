"use client";

// Registry of window-scoped surface agents contributed by mounted app windows
// (025-agent-delegation-v2), mirroring `client/surface-tools.ts`'s registry
// mechanism exactly: registered on mount, unregistered on unmount, snapshotted
// at run start and live-pushed mid-run (see `run-client.ts`). A surface agent
// is discoverable via `find_agent`/`agent_list` only while its window stays
// registered, with access to that window's own Tier-2 tools (FR-007).

export interface SurfaceAgentSpec {
  name: string;
  description: string;
  systemPrompt: string;
  toolNames: string[];
}

export interface SurfaceAgentEntry extends SurfaceAgentSpec {
  id: string;
  windowId: string;
}

const windowAgents = new Map<string, SurfaceAgentEntry>();

type ChangeListener = () => void;
const changeListeners = new Set<ChangeListener>();

export function onSurfaceAgentsChanged(cb: ChangeListener): () => void {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

function notifyChanged(): void {
  for (const cb of changeListeners) cb();
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

function surfaceIdsInUse(excludeWindowId: string): Set<string> {
  const ids = new Set<string>();
  for (const [windowId, entry] of windowAgents) {
    if (windowId !== excludeWindowId) ids.add(entry.id);
  }
  return ids;
}

/** Register a mounted app window's surface agent.
 *
 *  **Registration-time persisted-id collision check** (FR-023's actual
 *  requirement, plan-review C1): a synchronous-as-possible lookup against the
 *  persisted roster via the existing `/api/subagents` endpoint. On collision,
 *  the registration is REJECTED — never added to the registry — and logged
 *  via `clog()` (ships to the same central timeline as server-side logs, no
 *  new endpoint needed). This is in-band, at registration time, not merely a
 *  server log the registering app never sees.
 *
 *  A collision with another **currently-registered surface agent** (a
 *  different window) is handled locally and non-fatally: append a short
 *  `windowId`-derived suffix and proceed — this is expected, handled
 *  behavior, not a failure, so no log is emitted for it.
 *
 *  Async (unlike `registerAppSurfaceTools`, which is synchronous) because of
 *  the collision-check round-trip — accepted (plan Risk 6): there's a brief
 *  window between a mount and the surface agent becoming discoverable. */
export async function registerSurfaceAgent(windowId: string, spec: SurfaceAgentSpec): Promise<() => void> {
  let id = slugify(spec.name);

  try {
    const res = await fetch("/api/subagents");
    const data = (await res.json()) as { subAgents?: { id: string }[] };
    const persistedIds = new Set((data.subAgents ?? []).map((a) => a.id));
    if (persistedIds.has(id)) {
      const { clog } = await import("@/lib/logging/client/browser-logger");
      clog(
        "warn",
        "assistant.surface-agents",
        "surface agent registration rejected: id collides with a persisted agent",
        { windowId, id, name: spec.name },
      );
      return () => {};
    }
  } catch {
    // A network hiccup fails OPEN rather than blocking registration entirely
    // — the server-side run-start backstop (start-run.ts) still catches a
    // genuine collision; this client-side check is the PRIMARY mechanism,
    // not the only one.
  }

  if (surfaceIdsInUse(windowId).has(id)) {
    id = `${id}-${windowId.replace(/[^a-zA-Z0-9]/g, "").slice(-6)}`;
  }

  windowAgents.set(windowId, { ...spec, id, windowId });
  notifyChanged();
  return () => unregisterSurfaceAgent(windowId);
}

export function unregisterSurfaceAgent(windowId: string): void {
  if (!windowAgents.delete(windowId)) return;
  notifyChanged();
}

/** The union of every currently-registered window's surface agent, for the
 *  next run's snapshot (`start-run.ts`) and mid-run pushes (`run-client.ts`). */
export function getActiveSurfaceAgents(): SurfaceAgentEntry[] {
  return [...windowAgents.values()];
}
