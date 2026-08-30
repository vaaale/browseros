import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import { gitLogger } from "../logging";
import { gitLock } from "../lock";
import {
  runGitCommand,
  readFileAtRef,
  readFileAtRefBuffer,
  looksBinary,
  mergeFileWithMarkers,
  mergeTreeConflicts,
  makeError,
  gitIdentityEnv,
} from "../git-ops";
import {
  CONFLICT_ESCALATED_EVENT,
  isTerminalStatus,
  type ConflictDecision,
  type ConflictEscalatedPayload,
  type ConflictFileState,
  type ConflictHunk,
  type ConflictMarker,
  type ConflictSession,
  type ConflictSnapshot,
  type SessionCompletion,
  type SessionResult,
  type SessionStatus,
  type WorkContext,
} from "./types";

// 035-spec-promote-conflict-escalation — the resolution-session store.
//
// A session is the durable, resumable source of truth for ONE conflict
// resolution (FR-002): one JSON file under `data/gitops/sessions/`, written
// with the same atomic-write discipline as the config store. It is runtime
// state, not user content, so it lives under `data/` and NOT in the VFS
// (constitution V) and NOT in a spec store (it must not be branch-coupled).
//
// A `globalThis`-backed warm index holds live sessions so the in-process
// writers (the `conflict_*` tool handlers) and the HTTP writer (the pane's
// decision PATCH) serialize naturally against one map in one process. The
// file is the durable record; the index is the fast path and is rebuilt from
// disk by `loadSessionsFromDisk()` on boot.

const OP = "gitops.conflict-session";

function sessionsDir(): string {
  return path.join(dataDir(), "gitops", "sessions");
}

function sessionPath(id: string): string {
  return path.join(sessionsDir(), `${id}.json`);
}

interface SessionIndex {
  sessions: Map<string, ConflictSession>;
  loaded: boolean;
}

const GLOBAL_KEY = "__bosConflictSessions" as const;

function index(): SessionIndex {
  const g = globalThis as unknown as Record<string, SessionIndex | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { sessions: new Map(), loaded: false };
  return g[GLOBAL_KEY];
}

function newSessionId(): string {
  return `ses-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function newDecisionId(): string {
  return `dec-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function persist(session: ConflictSession): Promise<void> {
  session.updatedAt = Date.now();
  index().sessions.set(session.id, session);
  await writeFileAtomic(sessionPath(session.id), JSON.stringify(session, null, 2));
}

/** Rebuild the warm index from disk — the boot sweep's first step (FR-024). */
export async function loadSessionsFromDisk(): Promise<ConflictSession[]> {
  const idx = index();
  const dir = sessionsDir();
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const loaded: ConflictSession[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, name), "utf8");
      const session = JSON.parse(raw) as ConflictSession;
      if (!session?.id) continue;
      idx.sessions.set(session.id, session);
      loaded.push(session);
    } catch {
      // A corrupt session file must not stop the boot sweep from recovering
      // the others — it is recorded and skipped.
      gitLogger().warn({ op: `${OP}.load`, repoPath: dir, error: { code: "SESSION_UNREADABLE", message: name } });
    }
  }
  idx.loaded = true;
  return loaded;
}

async function ensureLoaded(): Promise<void> {
  if (!index().loaded) await loadSessionsFromDisk();
}

export async function getSession(id: string): Promise<ConflictSession | undefined> {
  const hit = index().sessions.get(id);
  if (hit) return hit;
  try {
    const raw = await fs.readFile(sessionPath(id), "utf8");
    const session = JSON.parse(raw) as ConflictSession;
    index().sessions.set(id, session);
    return session;
  } catch {
    return undefined;
  }
}

export async function listSessions(): Promise<ConflictSession[]> {
  await ensureLoaded();
  return [...index().sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** Every session still in a non-terminal state (`working` / `awaiting-user`).
 *  Drives the pane's "which session is active?" query on launch and refresh,
 *  and the boot sweep. */
export async function listActiveSessions(): Promise<ConflictSession[]> {
  return (await listSessions()).filter((s) => !isTerminalStatus(s.status));
}

/** The non-terminal session for a repo path, if any — the concurrent-op guard
 *  (US5 AS2 / S12) re-points to this instead of starting a parallel pipeline.
 *  A parked `awaiting-user` session counts as active exactly like `working`. */
export async function findActiveSessionForRepo(repoPath: string): Promise<ConflictSession | undefined> {
  return (await listActiveSessions()).find((s) => s.workContext.repoPath === repoPath);
}

// ── Snapshot capture (refs-based) ────────────────────────────────────────────

/** Capture the conflicting-file list from the three refs. Never reads
 *  `:1:`/`:2:`/`:3:` merge-index stages — by the time this runs the pipeline
 *  has already aborted the merge, so the stages are gone but the refs are not.
 *
 *  Two sources, unioned: any live unmerged index entries (when the caller
 *  happens to still have a conflicted tree) and the `merge-tree --write-tree`
 *  dry-run (which works with no working tree at all — the plumbing path). */
export async function captureSnapshot(
  repoPath: string,
  oursRef: string,
  theirsRef: string,
): Promise<{ snapshot: ConflictSnapshot; raw: string }> {
  const mb = await runGitCommand(["merge-base", oursRef, theirsRef], { cwd: repoPath });
  const base = mb.exitCode === 0 ? mb.stdout.trim() : "";

  const files = new Set<string>();
  const types: Record<string, ConflictMarker> = {};

  const unmerged = await runGitCommand(["diff", "--name-only", "--diff-filter=U"], { cwd: repoPath });
  if (unmerged.exitCode === 0) {
    for (const f of unmerged.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) files.add(f);
  }

  let raw = "";
  const tree = await mergeTreeConflicts(repoPath, base, oursRef, theirsRef).catch(() => null);
  if (tree) {
    raw = tree.raw;
    for (const f of tree.files) files.add(f);
    for (const [p, kind] of Object.entries(tree.types)) {
      types[p] = normalizeMarker(kind);
    }
  }

  return { snapshot: { base, ours: oursRef, theirs: theirsRef, files: [...files].sort(), types }, raw };
}

function normalizeMarker(kind: string): ConflictMarker {
  const k = kind.toLowerCase();
  if (k.includes("add/add")) return "add/add";
  if (k.includes("modify/delete")) return "modify/delete";
  if (k.includes("delete/modify")) return "delete/modify";
  if (k.includes("delete/delete")) return "delete/delete";
  return "modify/modify";
}

/** Derive a file's marker from the three refs when git didn't name one. */
async function deriveMarker(repoPath: string, snap: ConflictSnapshot, rel: string): Promise<ConflictMarker> {
  const declared = snap.types?.[rel];
  if (declared) return declared;
  const [b, o, t] = await Promise.all([
    readFileAtRef(repoPath, snap.base, rel),
    readFileAtRef(repoPath, snap.ours, rel),
    readFileAtRef(repoPath, snap.theirs, rel),
  ]);
  if (b === null && o !== null && t !== null) return "add/add";
  if (o === null && t !== null) return "delete/modify";
  if (o !== null && t === null) return "modify/delete";
  if (o === null && t === null) return "delete/delete";
  return "modify/modify";
}

/** The three-way read behind `conflict_read` (FR-005). Content comes from the
 *  refs; hunks come from a `git merge-file --diff3` rendering of those three
 *  contents, so the pane gets real marker-delimited hunks even though the
 *  merge itself was aborted long ago. */
export async function readThreeWay(
  session: ConflictSession,
  rel: string,
): Promise<{
  path: string;
  binary: boolean;
  marker: ConflictMarker;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  markers: string | null;
  hunks: ConflictHunk[];
}> {
  const repoPath = session.workContext.repoPath;
  const snap = session.snapshot;
  const [baseBuf, oursBuf, theirsBuf] = await Promise.all([
    readFileAtRefBuffer(repoPath, snap.base, rel),
    readFileAtRefBuffer(repoPath, snap.ours, rel),
    readFileAtRefBuffer(repoPath, snap.theirs, rel),
  ]);
  const binary = looksBinary(baseBuf) || looksBinary(oursBuf) || looksBinary(theirsBuf);
  const marker = await deriveMarker(repoPath, snap, rel);

  if (binary) {
    return { path: rel, binary: true, marker, base: null, ours: null, theirs: null, markers: null, hunks: [] };
  }

  const base = baseBuf === null ? null : baseBuf.toString("utf8");
  const ours = oursBuf === null ? null : oursBuf.toString("utf8");
  const theirs = theirsBuf === null ? null : theirsBuf.toString("utf8");

  const markers = await mergeFileWithMarkers(base, ours ?? "", theirs ?? "", {
    ours: `ours (${session.baseBranch || snap.ours})`,
    base: "base (merge-base)",
    theirs: `theirs (${session.featureBranch || snap.theirs})`,
  });

  const hunks = parseMarkerHunks(markers, rel, marker);
  // A whole-file conflict (add/add of a file with no common ancestor, or a
  // modify/delete) has no marker regions to parse — surface it as ONE hunk
  // spanning the file, so the pane always has something to render and the
  // agent always has something to decide on.
  if (hunks.length === 0) {
    hunks.push({
      path: rel,
      hunkIndex: 0,
      startLine: 1,
      endLine: Math.max(1, (ours ?? theirs ?? "").split("\n").length),
      base: base ?? undefined,
      ours: ours ?? "",
      theirs: theirs ?? "",
      marker,
      status: "pending",
    });
  }
  return { path: rel, binary: false, marker, base, ours, theirs, markers, hunks };
}

/** Parse `git merge-file --diff3` output into hunks. */
export function parseMarkerHunks(markers: string | null, rel: string, marker: ConflictMarker): ConflictHunk[] {
  if (!markers) return [];
  const lines = markers.split("\n");
  const hunks: ConflictHunk[] = [];
  let i = 0;
  let hunkIndex = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("<<<<<<<")) {
      i++;
      continue;
    }
    const startLine = i + 1;
    const ours: string[] = [];
    const base: string[] = [];
    const theirs: string[] = [];
    let bucket: "ours" | "base" | "theirs" = "ours";
    let sawBase = false;
    i++;
    while (i < lines.length && !lines[i].startsWith(">>>>>>>")) {
      if (lines[i].startsWith("|||||||")) {
        bucket = "base";
        sawBase = true;
      } else if (lines[i].startsWith("=======")) {
        bucket = "theirs";
      } else if (bucket === "ours") ours.push(lines[i]);
      else if (bucket === "base") base.push(lines[i]);
      else theirs.push(lines[i]);
      i++;
    }
    hunks.push({
      path: rel,
      hunkIndex: hunkIndex++,
      startLine,
      endLine: i + 1,
      base: sawBase ? base.join("\n") : undefined,
      ours: ours.join("\n"),
      theirs: theirs.join("\n"),
      marker,
      status: "pending",
    });
    i++;
  }
  return hunks;
}

// ── Creation ─────────────────────────────────────────────────────────────────

export interface CreateSessionInput {
  workContext: WorkContext;
  featureBranch: string;
  baseBranch: string;
  rollbackTag: string;
  conversationId: string;
  agentId: string;
  snapshot: ConflictSnapshot;
  completion: SessionCompletion;
  operationLabel: string;
  warnings?: string[];
}

export async function createSession(input: CreateSessionInput): Promise<ConflictSession> {
  await ensureLoaded();
  const now = Date.now();
  const files: ConflictFileState[] = [];
  for (const rel of input.snapshot.files) {
    const buf = await readFileAtRefBuffer(input.workContext.repoPath, input.snapshot.ours, rel).catch(() => null);
    const theirsBuf = await readFileAtRefBuffer(input.workContext.repoPath, input.snapshot.theirs, rel).catch(() => null);
    files.push({
      path: rel,
      binary: looksBinary(buf) || looksBinary(theirsBuf),
      marker: input.snapshot.types?.[rel] ?? "modify/modify",
    });
  }

  const session: ConflictSession = {
    id: newSessionId(),
    createdAt: now,
    updatedAt: now,
    status: "working",
    workContext: input.workContext,
    featureBranch: input.featureBranch,
    baseBranch: input.baseBranch,
    rollbackTag: input.rollbackTag,
    conversationId: input.conversationId,
    agentId: input.agentId,
    snapshot: input.snapshot,
    files,
    decisions: [],
    pendingDecision: null,
    runId: null,
    lastWorkingAt: now,
    completion: input.completion,
    result: null,
    warnings: input.warnings ? [...input.warnings] : [],
    operationLabel: input.operationLabel,
  };
  await persist(session);
  gitLogger().info({
    op: `${OP}.create`,
    repoPath: input.workContext.repoPath,
    success: true,
    error: undefined,
  });
  return session;
}

export async function setSessionRun(id: string, runId: string | null): Promise<void> {
  const session = await getSession(id);
  if (!session) return;
  session.runId = runId;
  await persist(session);
}

export async function addSessionWarning(id: string, warning: string): Promise<void> {
  const session = await getSession(id);
  if (!session) return;
  session.warnings.push(warning);
  await persist(session);
}

// ── The event (FR-007) ───────────────────────────────────────────────────────

/** Emit `com.bos.gitops.conflict.escalated`. Dynamically imported so the
 *  session store stays free of a static dependency on the event kernel (which
 *  the boot sweep starts after this module may already have been loaded). */
export async function emitEscalatedEvent(session: ConflictSession): Promise<void> {
  try {
    const events = await import("@/lib/events/api");
    const payload: ConflictEscalatedPayload = {
      sessionId: session.id,
      repoLabel: session.workContext.label,
      featureBranch: session.featureBranch,
      rollbackTag: session.rollbackTag,
      repoKind: session.workContext.repoKind,
    };
    await events.emit({
      type: CONFLICT_ESCALATED_EVENT,
      payload,
      source: { appId: "gitops", name: "GitOps", icon: "GitMerge" },
    });
  } catch (e) {
    // A failed emit must not take the escalation down — the pane still
    // recovers the session from its own store query on next open (FR-024).
    gitLogger().warn({
      op: `${OP}.emit`,
      repoPath: session.workContext.repoPath,
      error: { code: "EVENT_EMIT_FAILED", message: (e as Error).message },
    });
  }
}

// ── Resolution recording ─────────────────────────────────────────────────────

/** Record a resolved file (`conflict_write`, or a user decision applied
 *  through the pane). In `working-tree` mode the content also lands in the
 *  live tree; in `plumbing` mode it lives only on the session and the tree is
 *  built at completion time. */
export async function recordResolution(
  id: string,
  rel: string,
  content: string,
  by: "agent" | "user",
): Promise<ConflictSession> {
  const session = await getSession(id);
  if (!session) throw new Error(`unknown conflict session "${id}"`);
  let file = session.files.find((f) => f.path === rel);
  if (!file) {
    file = { path: rel, binary: false, marker: "modify/modify" };
    session.files.push(file);
  }
  if (file.binary) {
    throw makeError(
      "BINARY_CONFLICT",
      `"${rel}" is a binary file — it cannot be merged by writing text content. Surface it for manual handling (rollback tag ${session.rollbackTag}).`,
    );
  }
  file.resolvedContent = content;
  file.resolvedBy = by;
  file.waived = false;

  if (session.workContext.mode === "working-tree") {
    const abs = path.join(session.workContext.repoPath, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }
  await persist(session);
  return session;
}

/** Mark a file as knowingly NOT agent-resolvable (a binary conflict the agent
 *  surfaces rather than silently committing — FR-022). */
export async function waiveFile(id: string, rel: string, reason: string): Promise<ConflictSession> {
  const session = await getSession(id);
  if (!session) throw new Error(`unknown conflict session "${id}"`);
  const file = session.files.find((f) => f.path === rel);
  if (file) {
    file.waived = true;
    file.resolvedBy = undefined;
  }
  session.warnings.push(`${rel}: ${reason}`);
  await persist(session);
  return session;
}

export function unresolvedFiles(session: ConflictSession): string[] {
  return session.files.filter((f) => f.resolvedContent === undefined && !f.waived).map((f) => f.path);
}

// ── Decisions: park (FR-006) and re-wake (FR-010) ────────────────────────────

export interface AskDecisionInput {
  question: string;
  options?: { id: string; label: string }[];
  path?: string;
  hunk?: number;
  suggestion?: string;
}

/** The park half of park-and-rewake (ADR-2): the agent's run ENDS here.
 *  Blocking the loop on an indefinitely-parked promise would pin the
 *  conversation's run slot and could not survive a restart (D3 + FR-024). */
export async function askDecision(id: string, input: AskDecisionInput): Promise<ConflictDecision> {
  const session = await getSession(id);
  if (!session) throw new Error(`unknown conflict session "${id}"`);
  if (isTerminalStatus(session.status)) {
    throw new Error(`conflict session ${id} is already ${session.status} — no further decisions can be requested`);
  }
  const decision: ConflictDecision = {
    id: newDecisionId(),
    askedAt: Date.now(),
    question: input.question,
    options:
      input.options && input.options.length
        ? input.options
        : [
            { id: "ours", label: "Accept ours" },
            { id: "theirs", label: "Accept theirs" },
            { id: "keep-both", label: "Keep both" },
            ...(input.suggestion ? [{ id: "suggestion", label: "Accept the agent's suggestion" }] : []),
            { id: "manual", label: "Edit manually" },
          ],
    path: input.path,
    hunk: input.hunk,
    suggestion: input.suggestion,
  };
  session.decisions.push(decision);
  session.pendingDecision = decision;
  session.status = "awaiting-user";
  session.runId = null;
  await persist(session);
  gitLogger().info({ op: `${OP}.park`, repoPath: session.workContext.repoPath, success: true, error: undefined });
  return decision;
}

/** Record that the agent decided something WITHOUT asking (D2 / S7) — the
 *  decision timeline must show autonomous resolutions too, so the user can
 *  see what the agent did on its own. */
export async function recordAutonomousDecision(
  id: string,
  input: { question: string; path?: string; hunk?: number; chose: string },
): Promise<void> {
  const session = await getSession(id);
  if (!session) return;
  session.decisions.push({
    id: newDecisionId(),
    askedAt: Date.now(),
    question: input.question,
    options: [],
    path: input.path,
    hunk: input.hunk,
    autonomous: true,
    answer: { optionId: input.chose, answeredAt: Date.now() },
  });
  await persist(session);
}

export interface AnswerDecisionInput {
  decisionId?: string;
  optionId: string;
  manualText?: string;
}

/** The rewake half: record the answer, apply it to the file when it is
 *  mechanically derivable (ours / theirs / keep-both / suggestion / manual
 *  text), flip back to `working`, and start a NEW run on the SAME
 *  conversation whose first user message IS the answer. The transcript is
 *  continuous, so the agent picks up exactly where it left off. */
export async function answerDecision(id: string, input: AnswerDecisionInput): Promise<ConflictSession> {
  const session = await getSession(id);
  if (!session) throw new Error(`unknown conflict session "${id}"`);
  if (session.status !== "awaiting-user" || !session.pendingDecision) {
    throw new Error(`conflict session ${id} is not awaiting a decision (status: ${session.status})`);
  }
  const decision =
    (input.decisionId && session.decisions.find((d) => d.id === input.decisionId)) || session.pendingDecision;
  if (decision.answer) throw new Error(`decision ${decision.id} has already been answered`);

  decision.answer = { optionId: input.optionId, manualText: input.manualText, answeredAt: Date.now() };
  session.pendingDecision = null;
  session.status = "working";
  session.lastWorkingAt = Date.now();
  await persist(session);

  // Apply the answer to the file directly when we can derive the content — a
  // per-hunk button in the pane and the chat's decision card are the SAME
  // code path (design §5.2), so both land here.
  const rel = decision.path;
  if (rel) {
    const resolved = await deriveAnswerContent(session, rel, input, decision).catch(() => undefined);
    if (resolved !== undefined) {
      await recordResolution(session.id, rel, resolved, "user").catch(() => undefined);
    }
  }

  await relaunchAgent(session, answerMessage(session, decision, input));
  return (await getSession(id))!;
}

function answerMessage(session: ConflictSession, decision: ConflictDecision, input: AnswerDecisionInput): string {
  const target = decision.path ? ` for \`${decision.path}\`${decision.hunk !== undefined ? ` (hunk ${decision.hunk})` : ""}` : "";
  const manual = input.manualText ? `\n\nThe user's merged content${target}:\n\`\`\`\n${input.manualText}\n\`\`\`` : "";
  return [
    `The user answered decision \`${decision.id}\`${target} with: **${input.optionId}**.${manual}`,
    "",
    `Continue resolving conflict session \`${session.id}\`. Call \`conflict_status\` to see what is left, apply the answer with \`conflict_write\` if it is not already recorded, and call \`conflict_complete\` once every file is resolved.`,
  ].join("\n");
}

/** Derive the merged content implied by a decision option, so the common
 *  answers resolve without a second agent round-trip. Returns undefined for
 *  options only the agent can act on. */
async function deriveAnswerContent(
  session: ConflictSession,
  rel: string,
  input: AnswerDecisionInput,
  decision: ConflictDecision,
): Promise<string | undefined> {
  if (input.optionId === "manual" || input.optionId === "edit") return input.manualText;
  if (input.optionId === "suggestion") return decision.suggestion ?? input.manualText;
  const three = await readThreeWay(session, rel);
  if (three.binary) return undefined;
  if (input.optionId === "ours") return three.ours ?? "";
  if (input.optionId === "theirs") return three.theirs ?? "";
  if (input.optionId === "keep-both" || input.optionId === "both") {
    return `${three.ours ?? ""}${(three.ours ?? "").endsWith("\n") ? "" : "\n"}${three.theirs ?? ""}`;
  }
  return undefined;
}

/** Start a fresh run on the session's conversation. Dynamically imported to
 *  keep `store.ts → start-run.ts → registry.ts → conflict-resolve.ts →
 *  store.ts` from becoming a static import cycle. */
export async function relaunchAgent(session: ConflictSession, message: string): Promise<void> {
  try {
    const { startAssistantRun } = await import("@/lib/assistant/start-run");
    const run = await startAssistantRun({
      conversationId: session.conversationId,
      agentId: session.agentId,
      message,
    });
    await setSessionRun(session.id, run.id);
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    gitLogger().error({
      op: `${OP}.relaunch`,
      repoPath: session.workContext.repoPath,
      success: false,
      error: { code: "RELAUNCH_FAILED", message },
    });
    await failSession(session.id, `could not re-launch the conflict-resolution agent "${session.agentId}": ${message}`);
  }
}

// ── Terminal transitions + operation completion (§5.3) ───────────────────────

async function settle(session: ConflictSession, status: SessionStatus, result: SessionResult): Promise<ConflictSession> {
  session.status = status;
  session.result = result;
  session.pendingDecision = null;
  session.runId = null;
  await persist(session);
  gitLogger().info({
    op: `${OP}.${status}`,
    repoPath: session.workContext.repoPath,
    success: status === "resolved",
    error: result.error ? { code: "SESSION_FAILED", message: result.error } : undefined,
  });
  return session;
}

/** Resolve the session: apply the resolutions, complete the underlying
 *  operation, and settle. Any failure settles as `failed` WITH the rollback
 *  tag — never a silent success (FR-021). */
export async function completeSession(id: string, summary?: string): Promise<ConflictSession> {
  const session = await getSession(id);
  if (!session) throw new Error(`unknown conflict session "${id}"`);
  if (isTerminalStatus(session.status)) return session;

  const outstanding = unresolvedFiles(session);
  if (outstanding.length > 0) {
    throw new Error(
      `cannot complete: ${outstanding.length} file(s) still unresolved — ${outstanding.join(", ")}. Resolve them with conflict_write, ask the user with conflict_decision, or abandon with conflict_abandon.`,
    );
  }
  const waived = session.files.filter((f) => f.waived);
  if (waived.length > 0) {
    // FR-022: a waived (e.g. binary) conflict is NOT a resolution. Completing
    // over it would be exactly the silent-success this feature forbids.
    return failSession(
      id,
      `${waived.length} conflict(s) require manual handling and were not resolved: ${waived.map((f) => f.path).join(", ")}. Roll back with tag ${session.rollbackTag}.`,
    );
  }

  try {
    await runCompletion(session);
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    return failSession(id, `completing the operation failed: ${message}`);
  }
  return settle(session, "resolved", { kind: "resolved", summary });
}

export async function failSession(id: string, error: string): Promise<ConflictSession> {
  const session = await getSession(id);
  if (!session) throw new Error(`unknown conflict session "${id}"`);
  if (isTerminalStatus(session.status)) return session;
  await rollback(session).catch((e) => session.warnings.push(`rollback failed: ${(e as Error).message}`));
  return settle(session, "failed", { kind: "failed", error });
}

export async function timeoutSession(id: string, reason: string): Promise<ConflictSession> {
  const session = await getSession(id);
  if (!session) throw new Error(`unknown conflict session "${id}"`);
  if (isTerminalStatus(session.status)) return session;
  await rollback(session).catch((e) => session.warnings.push(`rollback failed: ${(e as Error).message}`));
  return settle(session, "timed-out", { kind: "timed-out", reason });
}

/** User-initiated abandon: restore the pre-reconciliation state via the
 *  rollback tag and close the session (FR-011, US5 AS1). */
export async function abandonSession(id: string, reason = "abandoned by the user"): Promise<ConflictSession> {
  const session = await getSession(id);
  if (!session) throw new Error(`unknown conflict session "${id}"`);
  if (isTerminalStatus(session.status)) return session;
  try {
    const { runManager } = await import("@/lib/assistant/run-manager");
    if (session.runId) runManager().cancel(session.runId);
  } catch {
    // No live run to cancel (restart, or already finished) — nothing to do.
  }
  await rollback(session).catch((e) => session.warnings.push(`rollback failed: ${(e as Error).message}`));
  return settle(session, "abandoned", { kind: "abandoned", reason });
}

/** Restore the working tree to the rollback tag. `main`/base is never left
 *  conflicted (FR-017) — the conflict only ever existed on the working
 *  branch, and this puts that branch back where it started. */
async function rollback(session: ConflictSession): Promise<void> {
  const { repoPath, mode } = session.workContext;
  if (mode !== "working-tree") return; // plumbing never touched a tree
  const release = await gitLock().acquire(repoPath, `${OP}.rollback`);
  try {
    await runGitCommand(["merge", "--abort"], { cwd: repoPath });
    await runGitCommand(["rebase", "--abort"], { cwd: repoPath });
    if (session.rollbackTag) {
      const reset = await runGitCommand(["reset", "--hard", session.rollbackTag], { cwd: repoPath });
      if (reset.exitCode !== 0) throw makeError("GIT_RESET_FAILED", reset.stderr);
      await runGitCommand(["clean", "-fd"], { cwd: repoPath });
    }
  } finally {
    await release();
  }
}

/** Perform the underlying operation now that every conflict is resolved.
 *
 *  The pipeline ABORTED the merge before escalating, so completion re-runs it
 *  and lets it conflict, then overwrites each conflicted path with the
 *  resolution and commits — producing a real merge commit with real
 *  parentage. If the tree is already merged (e.g. the source-repo path, where
 *  the DevOps agent resolves through `dev_delegate` and commits itself), the
 *  merge step is skipped and only the follow-on steps run. */
async function runCompletion(session: ConflictSession): Promise<void> {
  const { completion, workContext } = session;
  if (completion.kind === "none") return;

  if (completion.kind === "plumbing-merge") {
    await completePlumbing(session);
    return;
  }

  const repoPath = workContext.repoPath;
  const release = await gitLock().acquire(repoPath, `${OP}.complete`);
  try {
    const alreadyMerged = await isCleanAndMerged(session);
    if (!alreadyMerged) {
      await runGitCommand(["merge", "--abort"], { cwd: repoPath });
      // Undo our OWN eager writes before re-running the merge. `conflict_write`
      // puts the resolved content straight into the live tree (so the user can
      // see it), but git refuses to merge over locally-modified paths. The
      // resolutions live durably on the session, so restoring these paths to
      // HEAD loses nothing — they are re-applied below, after the merge.
      for (const file of session.files) {
        if (file.resolvedContent === undefined) continue;
        const restore = await runGitCommand(["checkout", "HEAD", "--", file.path], { cwd: repoPath });
        if (restore.exitCode !== 0) {
          // Not at HEAD (we created it) — just remove it.
          await fs.rm(path.join(repoPath, file.path), { force: true }).catch(() => undefined);
        }
      }

      const args =
        completion.strategy === "merge"
          ? ["merge", "--no-commit", "--no-ff", workContext.theirsRef]
          : ["merge", "--squash", workContext.theirsRef];
      // A non-zero exit here is the EXPECTED case: it means the merge
      // conflicted, which is exactly why we are in a resolution session. The
      // resolutions overwrite the conflicted paths next.
      await runGitCommand(args, { cwd: repoPath, env: await gitIdentityEnv(repoPath) });

      for (const file of session.files) {
        if (file.resolvedContent === undefined) continue;
        const abs = path.join(repoPath, file.path);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, file.resolvedContent, "utf8");
        const add = await runGitCommand(["add", "--", file.path], { cwd: repoPath });
        if (add.exitCode !== 0) throw makeError("GIT_ADD_FAILED", add.stderr);
      }

      const staged = await runGitCommand(["diff", "--cached", "--quiet"], { cwd: repoPath });
      if (staged.exitCode !== 0) {
        const commit = await runGitCommand(
          ["commit", "-m", `Merge ${workContext.theirsRef} (conflict resolution ${session.id})`],
          { cwd: repoPath, env: await gitIdentityEnv(repoPath) },
        );
        if (commit.exitCode !== 0) throw makeError("GIT_COMMIT_FAILED", commit.stderr || commit.stdout);
      }

      const stillConflicted = await runGitCommand(["diff", "--name-only", "--diff-filter=U"], { cwd: repoPath });
      if (stillConflicted.exitCode === 0 && stillConflicted.stdout.trim()) {
        throw makeError("MERGE_INCOMPLETE", `files are still conflicted after applying resolutions: ${stillConflicted.stdout.trim()}`);
      }
    }
  } finally {
    await release();
  }

  // Fast-forward the base branch onto the now-reconciled branch. This is why
  // main is never left conflicted (FR-017): the conflict was resolved on the
  // working branch, and base only ever moves by a fast-forward.
  if (completion.ff) {
    const { repoRoot, ffBranch } = completion.ff;
    const ff = await runGitCommand(["merge", "--ff-only", ffBranch], { cwd: repoRoot });
    if (ff.exitCode !== 0) throw makeError("GIT_FF_FAILED", ff.stderr || ff.stdout);
  }
  if (completion.pruneWorktree) {
    const { repoRoot, worktreePath } = completion.pruneWorktree;
    const rm = await runGitCommand(["worktree", "remove", "--force", worktreePath], { cwd: repoRoot });
    if (rm.exitCode !== 0) session.warnings.push(`worktree prune failed: ${rm.stderr || rm.stdout}`);
    await runGitCommand(["worktree", "prune"], { cwd: repoRoot });
  }
}

/** True when the working tree is clean AND the merge already landed — the
 *  case where the agent completed the resolution through another channel
 *  (`dev_delegate` on the source path), which must keep working exactly as it
 *  did before this feature (FR-023). */
async function isCleanAndMerged(session: ConflictSession): Promise<boolean> {
  const repoPath = session.workContext.repoPath;
  const status = await runGitCommand(["status", "--porcelain"], { cwd: repoPath });
  if (status.exitCode !== 0 || status.stdout.trim() !== "") return false;
  const head = await runGitCommand(["rev-parse", "HEAD"], { cwd: repoPath });
  const start = await runGitCommand(["rev-parse", session.snapshot.ours], { cwd: repoPath });
  // HEAD moved past where the pipeline left it ⇒ the agent committed something.
  return head.exitCode === 0 && start.exitCode === 0 && head.stdout.trim() !== start.stdout.trim();
}

/** The no-working-tree path (the Supervisor's busy-checkout case): build a
 *  tree from the resolutions with hash-object + update-index against a temp
 *  index, then commit-tree + update-ref. The live checkout is never touched,
 *  so whatever is using it keeps running undisturbed. */
async function completePlumbing(session: ConflictSession): Promise<void> {
  const { repoPath, oursRef, theirsRef } = session.workContext;
  const baseBranch = session.completion.plumbingBaseBranch || session.baseBranch;
  const release = await gitLock().acquire(repoPath, `${OP}.complete-plumbing`);
  const tmpIndex = path.join(repoPath, ".git", `bos-conflict-index-${session.id}`);
  try {
    const oursTip = (await runGitCommand(["rev-parse", oursRef], { cwd: repoPath })).stdout.trim();
    const theirsTip = (await runGitCommand(["rev-parse", theirsRef], { cwd: repoPath })).stdout.trim();
    const mb = (await runGitCommand(["merge-base", oursTip, theirsTip], { cwd: repoPath })).stdout.trim();

    // Start from merge-tree's best-effort tree (it resolves everything that
    // was NOT conflicted), then overwrite each conflicted path.
    const mt = await runGitCommand(["merge-tree", "--write-tree", `--merge-base=${mb}`, oursTip, theirsTip], { cwd: repoPath });
    const treeSha = mt.stdout.split("\n")[0]?.trim();
    if (!treeSha) throw makeError("MERGE_TREE_FAILED", mt.stderr || "merge-tree produced no tree");

    const env = { GIT_INDEX_FILE: tmpIndex };
    const readTree = await runGitCommandWithEnv(["read-tree", treeSha], repoPath, env);
    if (readTree.exitCode !== 0) throw makeError("GIT_READ_TREE_FAILED", readTree.stderr);

    for (const file of session.files) {
      if (file.resolvedContent === undefined) continue;
      const blob = await hashObject(repoPath, file.resolvedContent);
      const upd = await runGitCommandWithEnv(["update-index", "--add", "--cacheinfo", `100644,${blob},${file.path}`], repoPath, env);
      if (upd.exitCode !== 0) throw makeError("GIT_UPDATE_INDEX_FAILED", upd.stderr);
    }

    const written = await runGitCommandWithEnv(["write-tree"], repoPath, env);
    if (written.exitCode !== 0) throw makeError("GIT_WRITE_TREE_FAILED", written.stderr);
    const finalTree = written.stdout.trim();

    const commit = await runGitCommandWithEnv(
      ["commit-tree", finalTree, "-p", oursTip, "-p", theirsTip, "-m", `merge ${theirsRef} (conflict resolution ${session.id})`],
      repoPath,
      { ...env, ...(await gitIdentityEnv(repoPath)) },
    );
    if (commit.exitCode !== 0) throw makeError("GIT_COMMIT_TREE_FAILED", commit.stderr);

    const ref = await runGitCommand(["update-ref", `refs/heads/${baseBranch}`, commit.stdout.trim()], { cwd: repoPath });
    if (ref.exitCode !== 0) throw makeError("GIT_UPDATE_REF_FAILED", ref.stderr);
  } finally {
    await fs.rm(tmpIndex, { force: true }).catch(() => undefined);
    await release();
  }
}

async function hashObject(repoPath: string, content: string): Promise<string> {
  const tmp = path.join(repoPath, ".git", `bos-conflict-blob-${Math.random().toString(36).slice(2)}`);
  try {
    await fs.writeFile(tmp, content, "utf8");
    const res = await runGitCommand(["hash-object", "-w", tmp], { cwd: repoPath });
    if (res.exitCode !== 0) throw makeError("GIT_HASH_OBJECT_FAILED", res.stderr);
    return res.stdout.trim();
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

function runGitCommandWithEnv(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runGitCommand(args, { cwd, env });
}

/** FR-021's precondition: the working context must actually be usable before
 *  the agent claims to have done anything with it. Checked on the first tool
 *  call against a session; a failure is loud (session `failed` + rollback
 *  tag), never a silent no-op. */
export async function assertWorkContextUsable(session: ConflictSession): Promise<void> {
  const { repoPath, repoRoot, mode } = session.workContext;
  const gitDir = await runGitCommand(["rev-parse", "--git-dir"], { cwd: repoPath });
  if (gitDir.exitCode !== 0) {
    throw makeError(
      "NO_WORK_CONTEXT",
      `the conflict session's working context is not a git repository: ${repoPath} (repo root ${repoRoot}). Nothing was changed; roll back with tag ${session.rollbackTag}.`,
    );
  }
  if (mode === "working-tree") {
    try {
      await fs.access(repoPath);
      const probe = path.join(repoPath, `.bos-write-probe-${session.id}`);
      await fs.writeFile(probe, "");
      await fs.rm(probe, { force: true });
    } catch (e) {
      throw makeError(
        "NO_WORK_CONTEXT",
        `the conflict session's working tree is not writable: ${repoPath} (${(e as Error).message}). Nothing was changed; roll back with tag ${session.rollbackTag}.`,
      );
    }
  }
}
