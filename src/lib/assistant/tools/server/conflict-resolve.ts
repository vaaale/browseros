import "server-only";
import type { AssistantTool, ToolContext } from "../../tools";
import { serverTool, schema, p } from "./util";
import { getConversationConflictSessionId } from "@/lib/agent/conversations-server";
import {
  addSessionWarning,
  askDecision,
  assertWorkContextUsable,
  completeSession,
  failSession,
  getSession,
  readThreeWay,
  recordAutonomousDecision,
  recordResolution,
  unresolvedFiles,
  waiveFile,
} from "@/lib/gitops/sessions/store";
import type { ConflictSession } from "@/lib/gitops/sessions/types";

// 035-spec-promote-conflict-escalation — the repo-scoped conflict tools
// (ADR-1).
//
// These are the WHOLE access mechanism the conflict-resolution agent gets, and
// they work identically for every managed repo — BOS source, a spec store,
// user-apps, a VFS mount. Nothing here branches on `repoKind`; the per-repo
// variation lives entirely in the session's `WorkContext` (FR-003/FR-004).
//
// Why not extend `run_command`'s sandbox: that is a container with only
// `/workspace` + `/tmp`, and admitting an arbitrary data-dir path would hand
// the agent raw shell inside a git repo — far more surface than "read three
// refs, write a file". Why not the VFS `file_*` tools: they address VFS paths,
// not git refs, so they cannot produce three-way content at all.

/** Resolve the session this run is bound to. The context reaches the tool via
 *  the CONVERSATION (design §7.2) — `ToolContext` carries only a
 *  `conversationId` string, and the escalation tagged that conversation with
 *  `conflictSessionId`, exactly like the existing `activeFeatureBranch`. */
async function sessionFor(ctx: ToolContext): Promise<ConflictSession> {
  const sessionId = await getConversationConflictSessionId(ctx.conversationId);
  if (!sessionId) {
    throw new Error(
      "this conversation is not bound to a conflict-resolution session — the conflict_* tools only work inside a run started by the reconciliation pipeline's escalation",
    );
  }
  const session = await getSession(sessionId);
  if (!session) throw new Error(`conflict session "${sessionId}" no longer exists`);
  return session;
}

/** The access-control guard AND the FR-021 loud-fail precondition, applied on
 *  every call: the agent may only ever operate on THIS session's repo, and
 *  only if that repo is genuinely reachable and writable. A mismatch or an
 *  unusable context is an error the agent sees, never a silent no-op. */
async function bind(ctx: ToolContext, repoPath: unknown): Promise<ConflictSession> {
  const session = await sessionFor(ctx);
  const given = typeof repoPath === "string" ? repoPath.trim() : "";
  if (!given) throw new Error(`repo_path is required — this session's repo is ${session.workContext.repoPath}`);
  if (given !== session.workContext.repoPath) {
    throw new Error(
      `repo_path "${given}" is not this conflict session's repo. You may only operate on ${session.workContext.repoPath} (session ${session.id}).`,
    );
  }
  try {
    await assertWorkContextUsable(session);
  } catch (e) {
    const message = (e as { message?: string }).message ?? String(e);
    await failSession(session.id, message).catch(() => undefined);
    throw new Error(message);
  }
  return session;
}

function fileSummary(session: ConflictSession) {
  return session.files.map((f) => ({
    path: f.path,
    binary: f.binary,
    conflict: f.marker,
    resolved: f.resolvedContent !== undefined,
    resolvedBy: f.resolvedBy,
    waived: f.waived === true,
  }));
}

export function conflictResolveTools(): Record<string, AssistantTool> {
  return {
    conflict_read: serverTool(
      "conflict_read",
      "Read the three-way (ours / base / theirs) content of a conflicting file in the conflict-resolution session this conversation is bound to. Content is read from git REFS, so it works even after the merge was aborted and after a restart. Returns marker-delimited hunks. A binary file returns `binary: true` and no content — never attempt to merge one.",
      schema(
        {
          repo_path: p.str("The session's repo path (exactly as given in your task)."),
          file: p.str("Repo-relative path of the conflicting file. Omit to list every conflicting file."),
        },
        ["repo_path"],
      ),
      async (input, ctx) => {
        const session = await bind(ctx, input.repo_path);
        const rel = typeof input.file === "string" ? input.file.trim() : "";
        if (!rel) {
          return JSON.stringify({
            sessionId: session.id,
            repo: session.workContext.label,
            mode: session.workContext.mode,
            refs: session.snapshot,
            files: fileSummary(session),
          });
        }
        const three = await readThreeWay(session, rel);
        if (three.binary) {
          return JSON.stringify({
            path: rel,
            binary: true,
            conflict: three.marker,
            note: `"${rel}" is a binary file. It cannot be merged as text — do NOT call conflict_write on it. Surface it with conflict_decision (or conflict_abandon), naming the file and the rollback tag ${session.rollbackTag}.`,
          });
        }
        return JSON.stringify({
          path: rel,
          binary: false,
          conflict: three.marker,
          base: three.base,
          ours: three.ours,
          theirs: three.theirs,
          markers: three.markers,
          hunks: three.hunks.map((h) => ({
            hunkIndex: h.hunkIndex,
            startLine: h.startLine,
            endLine: h.endLine,
            base: h.base,
            ours: h.ours,
            theirs: h.theirs,
          })),
        });
      },
    ),

    conflict_write: serverTool(
      "conflict_write",
      "Write the resolved content of a conflicting file back into the conflict-resolution session's repo. Pass the FULL merged file content with all conflict markers removed. In working-tree mode this also writes the live file; in plumbing mode (no checkout) it is recorded and applied when the merge is built. Records the file as resolved by the agent.",
      schema(
        {
          repo_path: p.str("The session's repo path."),
          file: p.str("Repo-relative path of the file being resolved."),
          content: p.str("The full merged file content, markers removed."),
          rationale: p.str("One line on why this is the right merge — recorded in the decision timeline the user sees."),
        },
        ["repo_path", "file", "content"],
      ),
      async (input, ctx) => {
        const session = await bind(ctx, input.repo_path);
        const rel = String(input.file ?? "").trim();
        if (!rel) throw new Error("file is required");
        if (typeof input.content !== "string") throw new Error("content must be a string (the full merged file)");
        if (/^(<{7}|={7}|>{7})/m.test(input.content)) {
          throw new Error(`the content for "${rel}" still contains conflict markers — write the MERGED file, not the conflicted one`);
        }
        const updated = await recordResolution(session.id, rel, input.content, "agent");
        if (typeof input.rationale === "string" && input.rationale.trim()) {
          await recordAutonomousDecision(session.id, {
            question: `Resolve ${rel}`,
            path: rel,
            chose: input.rationale.trim(),
          });
        }
        const left = unresolvedFiles(updated);
        return JSON.stringify({
          ok: true,
          path: rel,
          remaining: left,
          next: left.length ? `${left.length} file(s) left: ${left.join(", ")}` : "everything is resolved — call conflict_complete",
        });
      },
    ),

    conflict_decision: serverTool(
      "conflict_decision",
      "Ask the USER to decide a conflict you genuinely cannot decide yourself. This PARKS the session: it returns `parked: true`, and you must then END YOUR TURN with no further tool calls. You are resumed in a new turn on this same conversation once the user answers, with your full context intact. Use this sparingly — resolve everything you reasonably can on your own first.",
      schema(
        {
          repo_path: p.str("The session's repo path."),
          question: p.str("The specific question for the user. Name the file and say what makes the two sides genuinely incompatible."),
          file: p.str("Repo-relative path the decision is about."),
          hunk: p.num("Hunk index within that file, when the decision is per-hunk."),
          suggestion: p.str("Your suggested merged content, if you have one — the user can accept it in one click."),
          options: p.strArr("Option ids to offer. Defaults to ours / theirs / keep-both / suggestion / manual."),
        },
        ["repo_path", "question"],
      ),
      async (input, ctx) => {
        const session = await bind(ctx, input.repo_path);
        const optionIds = Array.isArray(input.options) ? (input.options as unknown[]).map(String) : undefined;
        const decision = await askDecision(session.id, {
          question: String(input.question ?? "").trim(),
          path: typeof input.file === "string" && input.file.trim() ? input.file.trim() : undefined,
          hunk: typeof input.hunk === "number" ? input.hunk : undefined,
          suggestion: typeof input.suggestion === "string" && input.suggestion ? input.suggestion : undefined,
          options: optionIds?.map((id) => ({ id, label: id })),
        });
        return JSON.stringify({
          parked: true,
          decisionId: decision.id,
          message:
            "Waiting for the user's decision. END YOUR TURN now — do not call any more tools. You will be resumed with their answer as a new message on this conversation.",
        });
      },
    ),

    conflict_status: serverTool(
      "conflict_status",
      "Report the conflict-resolution session's current state: status, per-file resolution progress, and the decision timeline. Call this after being resumed, to see what is left.",
      schema({ repo_path: p.str("The session's repo path.") }, ["repo_path"]),
      async (input, ctx) => {
        const session = await bind(ctx, input.repo_path);
        return JSON.stringify({
          sessionId: session.id,
          status: session.status,
          repo: session.workContext.label,
          mode: session.workContext.mode,
          rollbackTag: session.rollbackTag,
          operation: session.operationLabel,
          files: fileSummary(session),
          remaining: unresolvedFiles(session),
          decisions: session.decisions.map((d) => ({
            id: d.id,
            question: d.question,
            path: d.path,
            hunk: d.hunk,
            autonomous: d.autonomous === true,
            answered: !!d.answer,
            answer: d.answer?.optionId,
            manualText: d.answer?.manualText,
          })),
          warnings: session.warnings,
        });
      },
    ),

    conflict_complete: serverTool(
      "conflict_complete",
      "Declare the conflict resolved. This COMPLETES the underlying operation (the merge is committed, base fast-forwarded, the worktree pruned as applicable). It refuses while any file is still unresolved. Only call it when every conflicting file has been written with conflict_write or answered by the user.",
      schema(
        {
          repo_path: p.str("The session's repo path."),
          summary: p.str("One paragraph on how you resolved it — shown to the user."),
        },
        ["repo_path"],
      ),
      async (input, ctx) => {
        const session = await bind(ctx, input.repo_path);
        const done = await completeSession(session.id, typeof input.summary === "string" ? input.summary : undefined);
        if (done.status !== "resolved") {
          return JSON.stringify({
            ok: false,
            status: done.status,
            error: done.result?.error ?? "the operation could not be completed",
            rollbackTag: done.rollbackTag,
          });
        }
        return JSON.stringify({
          ok: true,
          status: done.status,
          operation: done.operationLabel,
          message: `The ${done.operationLabel} completed. Rollback tag ${done.rollbackTag} is retained.`,
          warnings: done.warnings,
        });
      },
    ),

    conflict_abandon: serverTool(
      "conflict_abandon",
      "Give up on the resolution and roll the repo back to its pre-reconciliation state via the rollback tag. Use this when the conflict genuinely cannot be resolved (e.g. a binary file, or incompatible changes only a human can arbitrate). This is the honest outcome — never report success you did not achieve.",
      schema(
        {
          repo_path: p.str("The session's repo path."),
          reason: p.str("Why it cannot be resolved — the user reads this."),
          file: p.str("The file that forced the abandon, when there is one."),
        },
        ["repo_path", "reason"],
      ),
      async (input, ctx) => {
        const session = await bind(ctx, input.repo_path);
        const reason = String(input.reason ?? "").trim() || "the agent could not resolve the conflict";
        if (typeof input.file === "string" && input.file.trim()) {
          await waiveFile(session.id, input.file.trim(), reason).catch(() => undefined);
        } else {
          await addSessionWarning(session.id, reason).catch(() => undefined);
        }
        // `failed`, not `abandoned` — `abandoned` is reserved for the USER
        // pulling the plug from the pane (data-model.md). Both roll back.
        const done = await failSession(session.id, reason);
        return JSON.stringify({
          ok: true,
          status: done.status,
          rollbackTag: done.rollbackTag,
          message: `Rolled back to ${done.rollbackTag}. The ${done.operationLabel} was NOT completed. Reason: ${reason}`,
        });
      },
    ),
  };
}
