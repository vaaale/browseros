import { NextRequest, NextResponse } from "next/server";
import { listAgentTranscripts, readTranscript, readTranscriptEntries } from "@/lib/agent/subagents/transcript";
import { getCase } from "@/lib/self-heal/store";

export const dynamic = "force-dynamic";

// Read-only access to headless-run transcripts (031-self-healing scope-add,
// FR-030/FR-031, design ADR-14).
//
// GET only, deliberately: there is no write, patch or delete surface here, so
// nothing — agent or user — can alter or remove a run's record of what it did
// through this route. The runs write their own files (ADR-10); this route
// exists so the Build Studio Self-Heal pane can render them.
//
//   ?runId=<id>              → that run's structured entries (FR-037) + status
//   ?runId=<id>&format=md    → that run's markdown, verbatim, + status
//   ?agentId=<id>            → that agent's runs, newest first
//   ?caseId=<id>             → the self-heal case's linked runs, from the CASE RECORD
//
// `format=json` (the default) answers with `entries` — the .ndjson companion,
// parsed — which is what the Self-Heal pane renders as a conversation (FR-031).
// A run transcribed before the companion existed has no .ndjson: the json form
// then falls back to the markdown document, and the pane renders THAT verbatim.
//
// The `caseId` form reads `case.runs[]` rather than scanning the transcripts
// directory: the case record is the authority for "which runs belong to this
// case" (ADR-14), and the file's own `caseId` frontmatter is for a human
// opening the file, not for the query path.
//
// A run whose transcript is absent (transcriptions were disabled, or the file
// was pruned) is reported as `{ ok: true, found: false }` rather than 404: "this
// run was not transcribed" is a normal answer the pane renders as an empty
// state, not an error.

function err(code: string, message: string, status = 400) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const runId = params.get("runId");
  const agentId = params.get("agentId");
  const caseId = params.get("caseId");

  if (runId) {
    const doc = await readTranscript(runId);
    if (!doc) return NextResponse.json({ ok: true, found: false, runId, markdown: "" });
    if (params.get("format") !== "md") {
      const entries = await readTranscriptEntries(runId);
      // `markdown: undefined` drops the key from the JSON body — the entries
      // ARE the document, no point shipping both.
      if (entries) return NextResponse.json({ ok: true, found: true, ...doc, markdown: undefined, entries });
    }
    return NextResponse.json({ ok: true, found: true, ...doc });
  }

  if (agentId) {
    return NextResponse.json({ ok: true, agentId, runs: await listAgentTranscripts(agentId) });
  }

  if (caseId) {
    const record = await getCase(caseId);
    if (!record) return err("CASE_NOT_FOUND", `No self-heal case "${caseId}".`, 404);
    return NextResponse.json({ ok: true, caseId, runs: record.runs ?? [] });
  }

  return err("MISSING_PARAMS", "One of runId, agentId or caseId is required.");
}
