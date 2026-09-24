import "server-only";

// The in-flight headless-run registry (031-self-healing scope-add, FR-032,
// design ADR-11).
//
// Abort is ALREADY first-class inside a run — the agent loop checks its
// AbortSignal at every step boundary and after every tool batch (the chat's own
// Stop uses exactly that), and a CLI run has a child process its timeout can
// kill. What is missing is the HANDLE: `runLocalHeadless` passed a throwaway
// `new AbortController().signal` into the loop, and the CLI's `child` is a local
// reference. Neither is reachable by runId, so nothing outside a run could stop
// it. This module is that missing handle, and nothing more.
//
// **The cascade is the load-bearing part.** A self-heal pipeline case's
// in-flight run is the `build-studio` run (`type: local`); the actual coding is
// done by a NESTED Developer run (`type: claude`) that build-studio starts via
// `dev_delegate` — a separate top-level run with its own runId and its own
// spawned CLI child. The local runner's emit handler does not forward
// `tool_progress` to `opts.onEvent`, so that nested run is invisible to the
// parent's event stream, and aborting the parent's controller would merely
// unwind the build-studio loop while the Developer CLI kept editing the
// worktree. So a run is registered with its `parentRunId`, and aborting ANY
// member of a family aborts the whole family.
//
// Lives on `globalThis` (same hot-reload-safe pattern as in-run-agents.ts and
// the event kernel) so a run started in one module instance is abortable from
// an API route. Single-process by design: a headless run lives in exactly one
// process — the one that launched it — and the DURABLE record of a stop is the
// transcript's `aborted` mark plus the case's `stopped` state.

export interface RunHandle {
  /** Terminate this run. Local runs abort their controller; CLI runs SIGTERM
   *  their child and escalate to SIGKILL. Must be idempotent-safe. */
  abort: () => void;
  agentId?: string;
  /** The run that spawned this one, when it is nested (ADR-11's cascade). */
  parentRunId?: string;
}

export interface RunHandleInfo {
  runId: string;
  agentId?: string;
  parentRunId?: string;
  startedAt: number;
}

interface Entry extends RunHandle {
  startedAt: number;
}

const GLOBAL_KEY = "__bosHeadlessRuns" as const;

function runs(): Map<string, Entry> {
  const g = globalThis as unknown as Record<string, Map<string, Entry> | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map();
  return g[GLOBAL_KEY]!;
}

/** Register a run on start. Both headless runners do this; the matching
 *  `unregisterRun` lives in the local runner's `finally` and the CLI's `close`
 *  handler, so the map self-cleans. */
export function registerRun(runId: string, handle: RunHandle): void {
  if (!runId) return;
  runs().set(runId, { ...handle, startedAt: Date.now() });
}

/** Drop a run's registration. Idempotent — both a normal end and an abort can
 *  reach it. */
export function unregisterRun(runId: string): void {
  runs().delete(runId);
}

export function hasRun(runId: string): boolean {
  return runs().has(runId);
}

/** What is in flight right now (diagnostics, and the Stop handler's "is there
 *  actually a live run?" check). */
export function listRuns(): RunHandleInfo[] {
  return [...runs().entries()].map(([runId, e]) => ({
    runId,
    startedAt: e.startedAt,
    ...(e.agentId ? { agentId: e.agentId } : {}),
    ...(e.parentRunId ? { parentRunId: e.parentRunId } : {}),
  }));
}

/** `child → parent`, for the registered runs only. Built per walk (the map is
 *  tiny and short-lived), which keeps a `parentRunId` pointing at a run that has
 *  already finished from sending the walk anywhere. */
function parentLinks(map: Map<string, Entry>): Map<string, string> {
  const links = new Map<string, string>();
  for (const [id, entry] of map) {
    if (entry.parentRunId && map.has(entry.parentRunId)) links.set(id, entry.parentRunId);
  }
  return links;
}

/** The whole family a run belongs to: its ancestors, and every run that
 *  transitively descends from the topmost one. Visited-guarded, so a malformed
 *  `parentRunId` cycle can never wedge the walk. */
function family(map: Map<string, Entry>, runId: string): string[] {
  const links = parentLinks(map);
  let root = runId;
  const seenUp = new Set<string>([runId]);
  for (;;) {
    const parent = links.get(root);
    if (!parent || seenUp.has(parent)) break;
    seenUp.add(parent);
    root = parent;
  }
  const out = new Set<string>([root, runId, ...seenUp]);
  for (;;) {
    const before = out.size;
    for (const [child, parent] of links) {
      if (out.has(parent)) out.add(child);
    }
    if (out.size === before) break;
  }
  return [...out];
}

/** Abort each of these runs and deregister them. */
function abortEach(map: Map<string, Entry>, ids: string[]): string[] {
  const aborted: string[] = [];
  for (const id of ids) {
    const entry = map.get(id);
    map.delete(id);
    aborted.push(id);
    try {
      entry?.abort();
    } catch {
      // One handle failing to kill must not abandon the rest of the family —
      // an orphaned CLI child is the exact failure this module exists to
      // prevent.
    }
  }
  return aborted;
}

/**
 * Terminate an in-flight headless run — and everything it spawned, and the
 * parent that is waiting on it (ADR-11's cascade).
 *
 * `false` means "no such live run": already finished, or never started in this
 * process. Callers report that truthfully rather than claiming a kill (R14).
 *
 * Server-side platform export, deliberately NOT an agent-callable tool: it is
 * importable by the self-heal spine and the self-heal API route, and there is
 * no "kill any run" tool or endpoint in v1.
 */
export function abortHeadlessRun(runId: string): boolean {
  const map = runs();
  if (!map.has(runId)) return false;
  return abortEach(map, family(map, runId)).length > 0;
}

/** Abort a run's descendants, leaving the run itself alive — the downward half
 *  of the cascade, for a caller that wants to reclaim a wedged child without
 *  killing the run waiting on it. */
export function abortAllChildren(parentRunId: string): string[] {
  const map = runs();
  const links = parentLinks(map);
  const targets = new Set<string>();
  for (;;) {
    const before = targets.size;
    for (const [child, parent] of links) {
      if (child !== parentRunId && (parent === parentRunId || targets.has(parent))) targets.add(child);
    }
    if (targets.size === before) break;
  }
  return abortEach(map, [...targets]);
}

/** Tests only. */
export function _resetRunRegistryForTests(): void {
  const g = globalThis as unknown as Record<string, Map<string, Entry> | undefined>;
  g[GLOBAL_KEY] = new Map();
}
