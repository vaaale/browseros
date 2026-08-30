// 035-spec-promote-conflict-escalation — the persisted shapes for a git
// conflict-resolution session (data-model.md). Framework-free and
// server-only-free on purpose: the Build Studio pane imports these types to
// render the serialized session it fetches from /api/gitops/sessions.
//
// The ONE per-repo variable in the whole feature is `WorkContext` (FR-003 /
// FR-004): every repo kind — BOS source, a spec store, user-apps, a
// VFS-mounted repo — is reached through the SAME `conflict_*` tools acting on
// `repoPath`. There is no per-repo special-casing of the access mechanism.

/** Session status state machine (data-model.md §State machine).
 *  `working → awaiting-user → working | resolved | failed | timed-out`;
 *  `abandoned` is the user-triggered terminal. `awaiting-user` is NOT
 *  terminal and parks indefinitely (D3). */
export type SessionStatus =
  | "working"
  | "awaiting-user"
  | "resolved"
  | "failed"
  | "timed-out"
  | "abandoned";

export const TERMINAL_STATUSES: readonly SessionStatus[] = ["resolved", "failed", "timed-out", "abandoned"];

export function isTerminalStatus(s: SessionStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

/** Which managed repo the conflict is in. Used ONLY for labelling and for the
 *  source-repo `dev_delegate` note — never to branch the access mechanism. */
export type RepoKind = "source" | "user-specs" | "user-apps" | "vfs-mount" | "generic";

/** How the agent's resolutions are landed. `working-tree` = there is a live
 *  checkout to write into; `plumbing` = there is none (the Supervisor's
 *  busy-checkout path), so resolutions live only in the session and the merge
 *  is built with commit-tree/update-ref. */
export type WorkMode = "working-tree" | "plumbing";

/** The FR-003/FR-004 parameter: everything the agent needs to operate in the
 *  repo the conflict was detected in, configured at escalation time. */
export interface WorkContext {
  repoKind: RepoKind;
  /** Absolute path to the working tree the agent operates in. */
  repoPath: string;
  /** The repo root — differs from `repoPath` for a linked worktree. */
  repoRoot: string;
  /** `git merge-base` commit sha. Empty string when there is no merge base. */
  baseRef: string;
  /** The "ours" side — the branch being reconciled onto (HEAD of repoPath). */
  oursRef: string;
  /** The "theirs" side — the ref being merged in. */
  theirsRef: string;
  mode: WorkMode;
  /** Human label for the pane's status header ("user-specs store", …). */
  label: string;
  /** Source-repo only: the Supervisor-tracked feature branch, pre-set on the
   *  conversation so `dev_delegate` targets its worktree (FR-023 parity). */
  featureBranchForDelegate?: string;
}

/** Refs + the conflicting-file list. Per-file three-way CONTENT is never
 *  stored — it is re-derived from the refs by `git show <ref>:<rel>`, which is
 *  what makes a session restart-safe (research R1/R6). */
export interface ConflictSnapshot {
  base: string;
  ours: string;
  theirs: string;
  files: string[];
  /** path → conflict kind parsed from the merge-tree output, when known. */
  types?: Record<string, ConflictMarker>;
}

export type ConflictMarker =
  | "add/add"
  | "modify/modify"
  | "modify/delete"
  | "delete/modify"
  | "delete/delete";

/** In-memory only — returned by `conflict_read` and rendered by the pane. */
export interface ConflictHunk {
  path: string;
  hunkIndex: number;
  startLine: number;
  endLine: number;
  /** merge-base side; undefined for add/add (the file is absent at the base). */
  base?: string;
  ours: string;
  theirs: string;
  marker: ConflictMarker;
  /** The agent's proposed resolution — powers "accept agent's suggestion". */
  agentSuggestion?: string;
  status: "pending" | "resolved";
}

export interface DecisionOption {
  id: string;
  label: string;
}

export interface ConflictDecision {
  id: string;
  askedAt: number;
  question: string;
  options: DecisionOption[];
  /** The file (and optionally hunk) the decision is about. */
  path?: string;
  hunk?: number;
  /** The agent's suggested merged content, when it has one. */
  suggestion?: string;
  answer?: { optionId: string; manualText?: string; answeredAt: number };
  /** True when the agent resolved this without asking (S7 / D2). */
  autonomous?: boolean;
}

/** Per-file resolution progress, mirrored into the session so the pane can
 *  render the chip strip (D7) without asking the agent. */
export interface ConflictFileState {
  path: string;
  binary: boolean;
  marker: ConflictMarker;
  resolvedContent?: string;
  resolvedBy?: "agent" | "user";
  /** Set when the file is knowingly left unresolved (e.g. a binary waived). */
  waived?: boolean;
}

export interface SessionResult {
  kind: "resolved" | "failed" | "timed-out" | "abandoned";
  summary?: string;
  error?: string;
  reason?: string;
}

/** What finishing the resolution must actually DO to complete the underlying
 *  operation (design §5.3). Captured at session-creation time so completion
 *  works even when the detector was the Supervisor (a separate process). */
export interface SessionCompletion {
  /** `merge` — redo the merge in `repoPath` applying the resolutions, commit.
   *  `plumbing-merge` — no working tree: build a tree from the resolutions and
   *  advance the base ref with commit-tree/update-ref.
   *  `none` — the caller completes the operation itself. */
  kind: "merge" | "plumbing-merge" | "none";
  /** git strategy the pipeline was configured with, replayed on completion. */
  strategy: "merge" | "merge-squash" | "commit";
  /** For `plumbing-merge`: the branch ref to advance in `repoRoot`. */
  plumbingBaseBranch?: string;
  /** After a successful merge, fast-forward `baseBranch` in `repoRoot` to
   *  `ffBranch` (the user-specs promote invariant, FR-017). */
  ff?: { repoRoot: string; baseBranch: string; ffBranch: string };
  /** Prune this linked worktree once the operation completed. */
  pruneWorktree?: { repoRoot: string; worktreePath: string };
}

export interface ConflictSession {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  workContext: WorkContext;
  /** The branch being reconciled (source case: also the delegate target). */
  featureBranch: string;
  /** The branch it reconciles onto. */
  baseBranch: string;
  /** `bos/pre-reconcile-<stamp>` — created BEFORE any merge/rebase (FR-017). */
  rollbackTag: string;
  /** The (persisted, resumable) assistant conversation = the agent↔user
   *  channel (FR-007a). */
  conversationId: string;
  /** The configured conflict-resolution agent (FR-025). */
  agentId: string;
  snapshot: ConflictSnapshot;
  files: ConflictFileState[];
  decisions: ConflictDecision[];
  /** The currently-open request. Non-null ⇔ status === "awaiting-user". */
  pendingDecision: ConflictDecision | null;
  /** The live agent run id — null while parked or after a restart. */
  runId: string | null;
  /** Epoch ms of the last transition INTO `working` — the working-phase
   *  timeout budget is measured from here, never across a park (§9.3). */
  lastWorkingAt: number;
  completion: SessionCompletion;
  result: SessionResult | null;
  /** Best-effort cleanup failures — surfaced, never dropped. */
  warnings: string[];
  /** Free-text context from the detecting call site (shown in the pane). */
  operationLabel: string;
}

/** The event emitted on escalation (FR-007) and re-emitted by the boot sweep
 *  (FR-024). UI-only: there is no headless handler for it. */
export const CONFLICT_ESCALATED_EVENT = "com.bos.gitops.conflict.escalated";

export interface ConflictEscalatedPayload extends Record<string, unknown> {
  sessionId: string;
  repoLabel: string;
  featureBranch: string;
  rollbackTag: string;
  repoKind: RepoKind;
}
