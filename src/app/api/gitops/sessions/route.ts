import { NextRequest, NextResponse } from "next/server";
import {
  abandonSession,
  answerDecision,
  getSession,
  listActiveSessions,
  listSessions,
  readThreeWay,
} from "@/lib/gitops/sessions/store";
import { gitLogger } from "@/lib/gitops/logging";

export const dynamic = "force-dynamic";

// 035-spec-promote-conflict-escalation — the conflict-resolution session API.
//
// Server authority (constitution II): every git operation stays behind this
// boundary. The client only ever sees the SERIALIZED session, and the only
// mutation it can make is answering a decision (or abandoning) — it can never
// ask this route to run git directly. The agent never uses these routes at
// all; it goes through the in-process `conflict_*` tools.

function err(code: string, message: string, status = 400) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const id = params.get("id");

  if (!id) {
    // The pane's "which session is active?" query — this is what restores the
    // conflict pane after a plain browser refresh, with no event re-emit
    // (FR-024).
    const active = params.get("status") === "all" ? await listSessions() : await listActiveSessions();
    return NextResponse.json({ ok: true, sessions: active });
  }

  const session = await getSession(id);
  if (!session) return err("SESSION_NOT_FOUND", `No conflict session "${id}".`, 404);

  const file = params.get("file");
  if (file) {
    if (!session.snapshot.files.includes(file)) {
      return err("FILE_NOT_IN_SNAPSHOT", `"${file}" is not one of this session's conflicting files.`);
    }
    try {
      const three = await readThreeWay(session, file);
      return NextResponse.json({ ok: true, file: three });
    } catch (e) {
      return err("READ_FAILED", (e as Error).message, 500);
    }
  }

  return NextResponse.json({ ok: true, session });
}

export async function PATCH(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return err("MISSING_PARAMS", "id query param is required.");

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return err("INVALID_BODY", "Request body must be JSON.");
  }

  const session = await getSession(id);
  if (!session) return err("SESSION_NOT_FOUND", `No conflict session "${id}".`, 404);

  const action = typeof body.action === "string" ? body.action : "answer";

  try {
    if (action === "abandon") {
      const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "abandoned by the user";
      const done = await abandonSession(id, reason);
      gitLogger().warn({
        op: "api.gitops_sessions.abandon",
        repoPath: session.workContext.repoPath,
        success: true,
        error: { code: "CONFLICT_ABANDONED", message: reason },
      });
      return NextResponse.json({ ok: true, session: done });
    }

    if (action === "answer") {
      const optionId = typeof body.optionId === "string" ? body.optionId.trim() : "";
      if (!optionId) return err("MISSING_PARAMS", "optionId is required (ours | theirs | keep-both | suggestion | manual).");
      // The pane's per-hunk buttons and the chat's decision card are the SAME
      // code path (design §5.2) — both land here, and this is what re-wakes
      // the agent on a fresh run over the same conversation.
      const updated = await answerDecision(id, {
        decisionId: typeof body.decisionId === "string" ? body.decisionId : undefined,
        optionId,
        manualText: typeof body.manualText === "string" ? body.manualText : undefined,
      });
      return NextResponse.json({ ok: true, session: updated });
    }

    return err("UNKNOWN_ACTION", `Unknown action "${action}" (expected "answer" or "abandon").`);
  } catch (e) {
    return err("TRANSITION_FAILED", (e as Error).message);
  }
}

/** Design §4.3 parity: abandon-and-roll-back is also reachable as a DELETE. */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return err("MISSING_PARAMS", "id query param is required.");
  const session = await getSession(id);
  if (!session) return err("SESSION_NOT_FOUND", `No conflict session "${id}".`, 404);
  try {
    const done = await abandonSession(id, "abandoned by the user");
    return NextResponse.json({ ok: true, session: done });
  } catch (e) {
    return err("ABANDON_FAILED", (e as Error).message, 500);
  }
}
