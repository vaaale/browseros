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
  pushMode?: string;
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
  /** 035 (FR-018): set when a conflict during this operation was escalated. */
  sessionId?: string;
}

export async function supervisorPost(path: string, body?: Record<string, unknown>): Promise<PostResult> {
  try {
    const r = await fetch(`/__supervisor/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionHeader() },
      body: JSON.stringify(body ?? {}),
    });
    return (await r.json()) as PostResult;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Combine a promote's `pushResults` failures and `warnings` into one
 *  human-readable list, or `null` if there's nothing to report. Shared so
 *  every caller surfaces partial-promote failures the same way instead of
 *  only checking `pushResults` (the original, narrower precedent). */
export function promoteIssues(r: PostResult): string[] | null {
  const issues = [
    ...(r.pushResults ?? []).filter((p) => p.status === "failed").map((p) => `push to ${p.remoteName}: ${p.error || "unknown error"}`),
    ...(r.warnings ?? []),
  ];
  return issues.length ? issues : null;
}
