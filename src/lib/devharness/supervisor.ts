import "server-only";

// Thin client the BOS app uses to talk to the Supervisor control plane
// (tools/supervisor). Enabled only when BOS_SUPERVISOR_URL is set (i.e. the app
// is running under the Supervisor); otherwise every call is a no-op so the app
// works exactly as before (in-place self-modification).

function baseUrl(): string {
  return (process.env.BOS_SUPERVISOR_URL || "").replace(/\/$/, "");
}

export function supervisorEnabled(): boolean {
  return !!baseUrl();
}

async function call(pathname: string, init?: RequestInit): Promise<Record<string, unknown> | null> {
  const u = baseUrl();
  if (!u) return null;
  try {
    const res = await fetch(`${u}/__supervisor/${pathname}`, init);
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function supervisorState(): Promise<Record<string, unknown> | null> {
  return call("state");
}

/** Provision the `next` candidate worktree (+ data clone). Returns its path. */
export function supervisorBegin(): Promise<Record<string, unknown> | null> {
  return call("begin", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
}

/** Build + health-gate the candidate. */
export function supervisorBuild(): Promise<Record<string, unknown> | null> {
  return call("build", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
}

/**
 * Begin (or reuse) the app-content candidate: a branch in the apps repo (GitFS)
 * that the active server serves once checked out. Installing an app while a
 * candidate is active lands it on that branch (previewable), then the user
 * promotes or discards it. No-op (returns null) when not under the Supervisor.
 */
export function supervisorAppBegin(): Promise<Record<string, unknown> | null> {
  return call("app-begin", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
}
