import { sessionHeader } from "@/lib/logging/client/session";

// Shared client-side types + polling hook for the Supervisor's
// version-independent control surface (/__supervisor/*), used by both
// VersionControls.tsx (desktop topbar) and VersionsTab.tsx (Settings →
// Versions). Previously each component hand-rolled its own copy of these
// types and its own poll loop — they had already drifted — one shared source
// keeps them in sync.

export interface Ver {
  role: string;
  branch?: string;
  state: string;
  commit?: string;
  reused?: boolean;
  buildError?: string;
  buildLog?: string;
  /** Present while state is "escalated" — a promote's reconciliation
   *  pipeline handed a conflict to the DevOps Agent. Points at the
   *  (persisted, resumable) conversation so the user can watch/stop/
   *  interact with it, even after a browser refresh. */
  devopsConversationId?: string;
  /** 035 (FR-018): the conflict-resolution session behind that escalation —
   *  what the "Open resolution" button opens the Build Studio pane on. */
  conflictSessionId?: string;
}

export interface SupState {
  base: Ver | null;
  previews: Ver[];
  baseBranch?: string;
  serving?: { role: string; branch?: string } | null;
}

export interface Branches {
  branches: string[];
  base: string;
}

export interface PostResult {
  ok?: boolean;
  error?: string;
  state?: string;
  /** Reuse/dev-mode promote: base's `next dev` needs a manual restart (deps/config changed). */
  needsRestart?: boolean;
  message?: string;
  /** Per-remote push outcome from a promote (origin + any autoPush remotes). A
   *  "failed" entry means the promote itself succeeded but the push didn't —
   *  never silent, always surfaced. */
  pushResults?: { remoteName: string; status: "success" | "failed"; error?: string }[];
  /** Non-fatal cleanup/merge failures collected during the operation (e.g. a
   *  spec-store or user-apps merge conflict during promote) — the operation
   *  still succeeded overall, but this must be shown, not silently dropped. */
  warnings?: string[];
  /** Fix C: per-item service config (API key / settings) set in preview that
   *  will NOT survive the promote (preview data is disposable — base is
   *  canonical). Computed at the destructive step, so only available in the
   *  post-promote result; surfaced prominently so the user re-configures on
   *  base. A dedicated structured field (not folded into `warnings: string[]`)
   *  so the item + files survive for the UI to render. */
  dataLossWarnings?: { item: string; files: string[]; message: string }[];
  /** 035 (FR-018): set when a conflict during this operation was escalated. */
  sessionId?: string;
  /** Present on promote's initial (immediate) response — see promoteAndWait. */
  jobId?: string;
  /** Present only in a raw promote-status poll response, never elsewhere. */
  status?: "running" | "done" | "failed";
}

export async function supervisorPost(path: string, body?: Record<string, unknown>): Promise<PostResult> {
  let r: Response;
  try {
    r = await fetch(`/__supervisor/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionHeader() },
      body: JSON.stringify(body ?? {}),
    });
  } catch (e) {
    // The request never reached a server at all (DNS/connection failure, offline).
    return { ok: false, error: (e as Error).message };
  }
  try {
    return (await r.json()) as PostResult;
  } catch {
    // The request DID reach a server (unlike the network failure above), but its
    // body wasn't JSON. The common cause: a reverse proxy in front of BOS (e.g.
    // Dokploy's Traefik) times out waiting on a long-running operation (a
    // promote's rebuild can genuinely take minutes) and returns its OWN error
    // page to the client — while the real operation keeps running to
    // completion server-side, unaware the proxy already gave up on it. This is
    // NOT the same as the operation having failed.
    return {
      ok: false,
      error: `The server didn't send back a valid response (HTTP ${r.status}). This usually means a reverse proxy timed out waiting on a long-running operation, not that it failed — check Settings → Versions again in a minute; it very likely completed anyway.`,
    };
  }
}

const PROMOTE_POLL_MS = 3000;

async function fetchPromoteStatus(jobId: string): Promise<PostResult> {
  try {
    const r = await fetch(`/__supervisor/promote-status?jobId=${encodeURIComponent(jobId)}`, { headers: sessionHeader() });
    return (await r.json()) as PostResult;
  } catch {
    // A poll request failing (network blip) must not be read as the promote
    // itself having failed — keep polling rather than surface a false error.
    return { status: "running" };
  }
}

/** Promote can take minutes (a full base rebuild) — the server responds to
 *  the initial POST immediately with a job id instead of blocking that one
 *  HTTP request for the whole duration (which reverse proxies like Dokploy's
 *  time out on well before the real operation finishes, even though it keeps
 *  running to completion regardless). This polls "promote-status" until the
 *  job is done or failed, then returns the SAME shape a synchronous promote
 *  used to — every existing caller (promoteIssues, the sessionId/ok checks in
 *  VersionsTab) needs no other change. */
export async function promoteAndWait(branch: string): Promise<PostResult> {
  const started = await supervisorPost("promote", { branch });
  if (started.ok === false || !started.jobId) return started;
  const jobId = started.jobId;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, PROMOTE_POLL_MS));
    const poll = await fetchPromoteStatus(jobId);
    if (poll.status === "running") continue;
    // Only now — once base has actually finished rebuilding and is healthy
    // again — switch the pin to it. The initial POST deliberately doesn't
    // (see the matching comment in control.mjs's promote route): clearing
    // it any earlier would bounce the browser to base while it's mid-
    // rebuild and unreachable. A failed promote never touches the pin
    // either, matching the old synchronous behavior — stay wherever the
    // user already was.
    if (poll.status === "done") await supervisorPost("pin", { version: "base" });
    return poll;
  }
}

/** Combine a promote's `pushResults` failures and `warnings` into one
 *  human-readable list, or `null` if there's nothing to report. Shared so
 *  every caller surfaces partial-promote failures the same way instead of
 *  only checking `pushResults` (the original, narrower precedent). */
export function promoteIssues(r: PostResult): string[] | null {
  const issues = [
    ...(r.pushResults ?? []).filter((p) => p.status === "failed").map((p) => `push to ${p.remoteName}: ${p.error || "unknown error"}`),
    // Fix C: data-loss warnings are the most consequential (a silently dropped
    // API key) — list them first, with a marker, so they aren't buried.
    ...(r.dataLossWarnings ?? []).map((w) => `DATA NOT PROMOTED: ${w.message}`),
    ...(r.warnings ?? []),
  ];
  return issues.length ? issues : null;
}

/** Does this Supervisor action replace the build THIS WINDOW is served by?
 *
 *  The only reason to reload the page. It used to happen for every one of
 *  pin/stop/discard/promote, so deleting a branch threw the user out of
 *  Settings and back to a fresh desktop — and deleting several meant navigating
 *  back in each time. Nothing about discarding a branch you are not running
 *  changes the code answering these requests: the worktree destroyed is not the
 *  one serving them.
 *
 *    promote / pin  — the served build changes by definition
 *    stop / discard — only when we are serving THAT branch's preview
 */
export function replacesServedBuild(
  action: string,
  targetBranch: string,
  serving: SupState["serving"],
): boolean {
  if (action === "promote" || action === "pin") return true;
  if (action !== "stop" && action !== "discard") return false;
  return serving?.role === "preview" && serving.branch === targetBranch;
}
