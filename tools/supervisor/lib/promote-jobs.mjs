import { randomUUID } from "node:crypto";

// In-memory job tracking for control.mjs's "promote" route. A promote can
// genuinely take minutes (a full base rebuild) — blocking the ORIGINAL HTTP
// connection for that whole time is exactly what a reverse proxy in front of
// BOS (e.g. Dokploy's Traefik) times out on, well before the operation
// itself finishes, even though it keeps running to completion server-side
// regardless. The route now returns a job id immediately and runs the real
// operation in the background; the client polls "promote-status" instead of
// waiting on one long response — the proxy only ever sees fast,
// well-under-its-timeout request/response pairs. Jobs are pruned a while
// after finishing so this map can't grow unbounded across a long-lived
// Supervisor process.
const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000; // an hour is far longer than anyone reasonably waits to check a result

function pruneStale() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status !== "running" && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

/** Kick off `runner` in the background, tracked under a fresh job id.
 *  `runner`'s resolved value becomes the job's `result`; a thrown error's
 *  `message` (plus `sessionId`/`devopsConversationId` if present — promote's
 *  own conflict-escalation errors carry these, see promote.mjs) becomes the
 *  job's failure detail. Never throws itself — the caller gets the job id
 *  back immediately regardless of how `runner` turns out. */
export function startJob(runner) {
  pruneStale();
  const jobId = randomUUID();
  jobs.set(jobId, { status: "running" });
  runner()
    .then((result) => jobs.set(jobId, { status: "done", result, finishedAt: Date.now() }))
    .catch((e) => jobs.set(jobId, {
      status: "failed",
      error: String(e?.message || e),
      ...(e?.sessionId ? { sessionId: e.sessionId } : {}),
      ...(e?.devopsConversationId ? { devopsConversationId: e.devopsConversationId } : {}),
      finishedAt: Date.now(),
    }));
  return jobId;
}

/** The job's current state, or null if unknown (never existed, or pruned —
 *  the caller treats both the same: "nothing to report"). */
export function getJob(jobId) {
  return jobs.get(jobId) || null;
}
