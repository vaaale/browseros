import { NextRequest, NextResponse } from "next/server";
import * as vfs from "@/os/vfs";
import { getCase, listCases, readIndex } from "@/lib/self-heal/store";
import { readSelfHealConfig } from "@/lib/self-heal/config";
import { costStatus } from "@/lib/self-heal/cost";
import { applyApprovedEdit, dismissCase } from "@/lib/self-heal/consent";
import { discardCase, escalateCase, resumeCase, selfHealIntake, settleBranchOutcome, startRun, stopRun } from "@/lib/self-heal/intake";
import { emitSelfHeal } from "@/lib/self-heal/events";
import { SELF_HEAL_EVENTS, humanCaseId } from "@/lib/self-heal/types";

export const dynamic = "force-dynamic";

// The Build Studio Self-Heal pane's API (031-self-healing FR-022).
//
// Server authority (constitution II): the pane only ever sees SERIALIZED cases,
// and the only mutations it can ask for are the eight the user is actually
// entitled to make — report, consent, answer, dismiss, (031-self-healing
// scope-add) stop/start a run (FR-034) and discard a case (FR-036), and the
// branch-settled notice the version controls send after a promote/discard
// (FR-038 — it names a branch and an outcome, never a diff or a git op). It cannot
// ask this route to run git, to
// promote, or to apply an arbitrary edit: a consent POST carries no diff, only a
// case id, and the edit applied is the one the Diagnostician already recorded on
// that case. Stop/start likewise carry only a case id — the run they act on is
// the one the CASE says is in flight, never a runId the caller names, so this
// route is not a "kill any headless run" endpoint. The agent never uses this
// route at all; it goes through the in-process `self_heal_*` tools.

function err(code: string, message: string, status = 400) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const caseId = params.get("caseId");

  if (caseId) {
    const record = await getCase(caseId);
    if (!record) return err("CASE_NOT_FOUND", `No self-heal case "${caseId}".`, 404);
    // The report is the centrepiece of the detail view, so it is inlined here
    // rather than making the pane do a second (VFS-scoped) fetch for it.
    const report = record.reportPath ? await vfs.readText(record.reportPath).catch(() => "") : "";
    // `runs` and `stuckSignature` ride the serialized case (they ARE case
    // fields), and are surfaced at the top level too so the pane's Transcripts
    // section and stuck indicator do not have to know that (FR-022f/g).
    return NextResponse.json({
      ok: true,
      case: record,
      report,
      runs: record.runs ?? [],
      ...(record.stuckSignature ? { stuckSignature: record.stuckSignature } : {}),
    });
  }

  const [cases, cfg, index, cost] = await Promise.all([listCases(), readSelfHealConfig(), readIndex(), costStatus()]);
  return NextResponse.json({
    ok: true,
    cases,
    config: cfg,
    cost,
    inFlightCaseId: index.inFlightSlowPathCaseId,
    slowQueue: index.slowQueue.map((e) => e.caseId),
    costQueue: index.costQueue.map((e) => e.caseId),
  });
}

export async function POST(req: NextRequest) {
  const op = req.nextUrl.searchParams.get("op") ?? "report";
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return err("INVALID_BODY", "Request body must be JSON.");
  }
  const caseId = typeof body.caseId === "string" ? body.caseId.trim() : "";

  try {
    if (op === "report") {
      // C1: the user-facing entry point for FR-001 — the pane's "Report a
      // problem" button. Same front door as the agent tool, same guards.
      const description = typeof body.description === "string" ? body.description.trim() : "";
      if (!description) return err("MISSING_PARAMS", "description is required.");
      const outcome = await selfHealIntake({
        trigger: "explicit",
        description,
        ...(typeof body.toolName === "string" && body.toolName.trim() ? { toolName: body.toolName.trim() } : {}),
        ...(typeof body.errorMessage === "string" && body.errorMessage.trim() ? { errorMessage: body.errorMessage.trim() } : {}),
        ...(typeof body.conversationId === "string" && body.conversationId.trim() ? { conversationId: body.conversationId.trim() } : {}),
        ...(typeof body.appId === "string" && body.appId.trim() ? { appId: body.appId.trim() } : {}),
      });
      return NextResponse.json({ ok: true, outcome });
    }

    if (op === "branch-settled") {
      // FR-038(a): the topbar / Versions tab just promoted or discarded a
      // branch — close every preview-ready case waiting on it. Branch-scoped,
      // not case-scoped: the caller knows the branch, not which cases (if any)
      // link to it, and "none did" is a normal answer, not an error.
      const branch = typeof body.branch === "string" ? body.branch.trim() : "";
      const outcome = body.outcome === "promoted" || body.outcome === "discarded" ? body.outcome : null;
      if (!branch || !outcome) {
        return err("MISSING_PARAMS", 'branch and outcome ("promoted" | "discarded") are required.');
      }
      const settled = await settleBranchOutcome(branch, outcome);
      return NextResponse.json({ ok: true, settled });
    }

    if (!caseId) return err("MISSING_PARAMS", "caseId is required.");
    const record = await getCase(caseId);
    if (!record) return err("CASE_NOT_FOUND", `No self-heal case "${caseId}".`, 404);

    if (op === "consent") {
      // "Approve edit" for a class-b/c case, or "start the fix" for a case that
      // was parked because autonomous implement is off.
      const approve = body.approve !== false;
      if (!approve) {
        const dismissed = await dismissCase(caseId, "the proposed edit was rejected");
        if (!dismissed.ok) return err("DISMISS_FAILED", dismissed.error);
        return NextResponse.json({ ok: true, case: dismissed.record });
      }
      if (record.scopeClass === "e" || record.scopeClass === "d-bis") {
        const outcome = await escalateCase(caseId);
        const updated = await getCase(caseId);
        return NextResponse.json({ ok: true, case: updated, outcome });
      }
      const applied = await applyApprovedEdit(caseId);
      if (!applied.ok) return err("APPLY_FAILED", applied.error);
      return NextResponse.json({ ok: true, case: applied.record, target: applied.target });
    }

    if (op === "answer") {
      const answer = typeof body.answer === "string" ? body.answer.trim() : "";
      if (!answer) return err("MISSING_PARAMS", "answer is required.");
      if (record.status !== "suspended") {
        return err("NOT_SUSPENDED", `Case ${humanCaseId(caseId)} is "${record.status}", not waiting on an answer.`);
      }
      // Emitted for the audit trail even though the resume runs in-process
      // here: the spine's own handler also accepts this event, so an external
      // answerer (a future integration) gets the identical path.
      await emitSelfHeal(SELF_HEAL_EVENTS.decisionResolved, {
        caseId,
        answer,
        summary: `${humanCaseId(caseId)} decision answered`,
        selfHeal: { role: "lifecycle", caseId },
      });
      const resumed = await resumeCase(caseId, answer);
      return NextResponse.json({ ok: true, case: resumed });
    }

    if (op === "stop") {
      // Idempotent by design: a run that finished between the click and here
      // is not an error, it is a no-op that reports the current status (R14).
      const outcome = await stopRun(caseId);
      if (!outcome.ok) return err("STOP_FAILED", outcome.reason ?? "the run could not be stopped");
      return NextResponse.json({ ok: true, case: outcome.case ?? record, stopped: outcome.changed, reason: outcome.reason });
    }

    if (op === "start") {
      const outcome = await startRun(caseId);
      if (!outcome.ok) return err("START_FAILED", outcome.reason ?? "the run could not be started");
      return NextResponse.json({ ok: true, case: outcome.case ?? record, started: outcome.changed, reason: outcome.reason });
    }

    if (op === "discard") {
      // FR-036: the one destructive op — the record is deleted, not closed. The
      // confirm guard lives in the UI; the server just does what it is told, on
      // the case named and nothing else. Transcripts are not touched.
      const outcome = await discardCase(caseId);
      return NextResponse.json({ ok: true, discarded: outcome.discarded });
    }

    if (op === "dismiss") {
      const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined;
      const dismissed = await dismissCase(caseId, reason);
      if (!dismissed.ok) return err("DISMISS_FAILED", dismissed.error);
      return NextResponse.json({ ok: true, case: dismissed.record });
    }

    return err("UNKNOWN_OP", `Unknown op "${op}". Expected report | consent | answer | dismiss | stop | start | discard | branch-settled.`);
  } catch (e) {
    return err("SELF_HEAL_FAILED", (e as Error).message, 500);
  }
}
