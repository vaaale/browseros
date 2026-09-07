// Unit tests for tools/supervisor/lib/promote-jobs.mjs — the job-tracking
// wrapper that makes control.mjs's "promote" route respond immediately
// instead of blocking one HTTP request for the whole promote duration
// (which reverse proxies like Dokploy's Traefik time out on well before a
// real promote/rebuild finishes).
//
//   node --test tests/supervisor/promote-jobs.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const { startJob, getJob } = await import("../../tools/supervisor/lib/promote-jobs.mjs");

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("startJob: returns a job id immediately, before the runner resolves", async () => {
  let resolveRunner;
  const runner = () => new Promise((resolve) => { resolveRunner = resolve; });
  const jobId = startJob(runner);

  assert.equal(typeof jobId, "string");
  assert.ok(jobId.length > 0);
  assert.deepEqual(getJob(jobId), { status: "running" }, "must be running until the runner settles");

  resolveRunner({ tag: "bos/v-test" });
  await nextTick();
});

test("startJob: a successful runner's resolved value becomes the job's result", async () => {
  const jobId = startJob(async () => ({ tag: "bos/v-test", pushResults: [] }));
  await nextTick();

  const job = getJob(jobId);
  assert.equal(job.status, "done");
  assert.deepEqual(job.result, { tag: "bos/v-test", pushResults: [] });
  assert.equal(typeof job.finishedAt, "number");
});

test("startJob: a rejected runner's error message becomes the job's failure detail", async () => {
  const jobId = startJob(async () => { throw new Error("base checkout has uncommitted changes"); });
  await nextTick();

  const job = getJob(jobId);
  assert.equal(job.status, "failed");
  assert.equal(job.error, "base checkout has uncommitted changes");
  assert.equal(job.sessionId, undefined);
  assert.equal(job.devopsConversationId, undefined);
});

test("startJob: an error carrying sessionId/devopsConversationId (promote's own conflict-escalation shape) preserves both on the job", async () => {
  const jobId = startJob(async () => {
    const err = new Error("promote blocked — merge conflicted, escalated to the conflict-resolution agent");
    err.sessionId = "sess-123";
    err.devopsConversationId = "c-abc";
    throw err;
  });
  await nextTick();

  const job = getJob(jobId);
  assert.equal(job.status, "failed");
  assert.equal(job.sessionId, "sess-123");
  assert.equal(job.devopsConversationId, "c-abc");
});

test("getJob: an unknown job id returns null, not a throw", () => {
  assert.equal(getJob("never-existed"), null);
});

test("startJob: two concurrent jobs never see each other's state", async () => {
  let resolveFirst;
  const firstId = startJob(() => new Promise((resolve) => { resolveFirst = resolve; }));
  const secondId = startJob(async () => "second done");
  await nextTick();

  assert.deepEqual(getJob(firstId), { status: "running" });
  assert.equal(getJob(secondId).status, "done");

  resolveFirst("first done");
  await nextTick();
  assert.equal(getJob(firstId).result, "first done");
});
