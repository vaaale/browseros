import "server-only";
import { getLogContext } from "@/lib/logging/context";
import { logger } from "@/lib/logging/server-logger";

// Thin client the BOS app uses to talk to the Supervisor control plane
// (tools/supervisor). Enabled only when BOS_SUPERVISOR_URL is set (i.e. the app
// is running under the Supervisor); otherwise every call is a no-op. Source-edit
// developer harness runs fail closed when this client is disabled, so BOS never
// falls back to modifying the live checkout in place.

function baseUrl(): string {
  return (process.env.BOS_SUPERVISOR_URL || "").replace(/\/$/, "");
}

export function supervisorEnabled(): boolean {
  return !!baseUrl();
}

async function call(pathname: string, init?: RequestInit): Promise<Record<string, unknown> | null> {
  const u = baseUrl();
  if (!u) return null;
  // Forward the request's browser session id so the Supervisor attributes this
  // control action (e.g. a build) to the same session timeline as the chat.
  const sessionId = getLogContext().sessionId;
  const headers = {
    ...(init?.headers as Record<string, string> | undefined),
    ...(sessionId ? { "x-bos-session": sessionId } : {}),
  };
  try {
    const res = await fetch(`${u}/__supervisor/${pathname}`, { ...init, headers });
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    // Every caller here treats `null` as "not running under the Supervisor"
    // — but BOS_SUPERVISOR_URL was set, so this is actually a genuine
    // request failure (the Supervisor crashed mid-request, a network blip,
    // etc), not "disabled". At minimum this must be visible instead of
    // silently collapsing into the same "disabled" signal every caller
    // already treats as a normal, expected no-op.
    logger().warn("devharness.supervisor", `request to /__supervisor/${pathname} failed`, { error: (err as Error)?.message ?? String(err) });
    return null;
  }
}

export function supervisorState(): Promise<Record<string, unknown> | null> {
  return call("state");
}

/** All git branches the Supervisor knows about. Returns null when not under the
 *  Supervisor. */
export function supervisorBranches(): Promise<Record<string, unknown> | null> {
  return call("branches");
}

/** Files changed on the preview vs base (committed in its worktree), so the
 *  assistant's gitStatus can see a preview even though the main checkout is clean.
 *  Returns null when not under the Supervisor. */
export function supervisorNextChanges(branch?: string): Promise<Record<string, unknown> | null> {
  const qs = branch ? `?branch=${encodeURIComponent(branch)}` : "";
  return call(`preview-changes${qs}`);
}

/** Provision the preview worktree (+ data clone) for a feature branch. */
export function supervisorBegin(branch: string): Promise<Record<string, unknown> | null> {
  return call("begin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branch }),
  });
}

/**
 * `supervisorBegin`, but the real failure reason always survives instead of
 * getting collapsed into a generic "not mounted, maybe busy, retry" guess by
 * every caller: a network/parse failure (already logged by `call()` above),
 * an `{ok:false, error}` response (e.g. the Supervisor's own git fetch
 * failed), and a missing `worktree` field are all distinct thrown errors
 * carrying the actual cause. Callers still decide for themselves whether a
 * caught error should fail loudly (writes) or fall back with logging
 * (reads) — this only stops the cause itself from being thrown away.
 */
export async function supervisorBeginOrThrow(
  branch: string,
): Promise<{ worktree: string; dataDir: string; mountErrors?: Record<string, string> }> {
  const begun = await supervisorBegin(branch);
  if (!begun) {
    throw new Error(`Supervisor request failed for branch "${branch}" (see devharness.supervisor logs for detail)`);
  }
  if (begun.ok === false) {
    throw new Error(String(begun.error ?? "begin failed for an unknown reason"));
  }
  const worktree = typeof begun.worktree === "string" ? begun.worktree : "";
  if (!worktree) {
    throw new Error(`Supervisor returned no worktree for branch "${branch}"`);
  }
  // The preview's data clone, where the branch-coupled `user-apps` worktree is
  // mounted. Unlike `worktree` this is not fatal when absent — only item-owned
  // spec stores need it, and they raise their own, specific error (spec-fs's
  // branchItemStoreRoot) rather than breaking every other caller of begin.
  const dataDir = typeof begun.dataDir === "string" ? begun.dataDir : "";
  return { worktree, dataDir, mountErrors: begun.mountErrors as Record<string, string> | undefined };
}

/** Build + health-gate the preview for a feature branch. */
export function supervisorBuild(branch: string): Promise<Record<string, unknown> | null> {
  return call("build", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ branch }) });
}

// The app-content candidate (`supervisorAppBegin`, /__supervisor/app-begin) is
// retired. `data/user-apps` is a branch-COUPLED repo like every spec store —
// it mounts as a worktree on the active `bos/*` feature branch and promotes or
// discards with the code — so there is no second, in-place branch scheme over
// it any more, and no separate promote/discard surface for app content.
