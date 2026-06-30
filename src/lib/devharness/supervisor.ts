import "server-only";
import { getLogContext } from "@/lib/logging/context";

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
  } catch {
    return null;
  }
}

export function supervisorState(): Promise<Record<string, unknown> | null> {
  return call("state");
}

/** All git branches the Supervisor knows about. Used to check that a remembered
 *  branch-key still exists before trying to resume it, so a manually-deleted (or
 *  promoted-and-deleted) branch starts fresh instead of being resurrected. Returns
 *  null when not under the Supervisor. */
export function supervisorBranches(): Promise<Record<string, unknown> | null> {
  return call("branches");
}

/** Files changed on the preview vs base (committed in its worktree), so the
 *  assistant's gitStatus can see a preview even though the main checkout is clean.
 *  Returns null when not under the Supervisor. */
export function supervisorNextChanges(conversationId?: string): Promise<Record<string, unknown> | null> {
  const qs = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
  return call(`preview-changes${qs}`);
}

/** Provision (or resume) the preview worktree (+ data clone) for a conversation.
 *  When `branch` is given, that branch is checked out with its history (continuity /
 *  resume); otherwise a fresh `bos/next-*` branch is created. Returns `{ branch, worktree }`. */
export function supervisorBegin(conversationId: string, branch?: string): Promise<Record<string, unknown> | null> {
  return call("begin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, ...(branch ? { branch } : {}) }),
  });
}

/** Build + health-gate the preview for a conversation. */
export function supervisorBuild(conversationId: string): Promise<Record<string, unknown> | null> {
  return call("build", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId }) });
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
