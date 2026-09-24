// Unit tests for tools/supervisor/lib/conversations.mjs's clearActiveFeatureBranch.
//
// Regression coverage for two issues found in review:
//  1. The original implementation wrote conversation JSON files directly
//     (`fs.writeFile`, not atomic) — a second, uncoordinated writer of a file
//     whose real single writer is base's own agent loop
//     (conversation-store.ts), serialized through its own per-conversation
//     queue. A concurrent agent turn's own save could silently revert the
//     clear, and the write wasn't even atomic (the project's own contract:
//     every store under `data/` must write atomically).
//  2. The fix routes the actual clear through base's own
//     `PATCH /api/assistant/feature-branches` (matching how push.mjs reaches
//     base's git-credential-aware push instead of reimplementing it
//     standalone) — this suite verifies that call shape, and that a
//     completely unreachable/not-ready base degrades to a loud, recorded
//     warning rather than a silent no-op or a thrown error that would abort
//     the promote it's called from.
//
//   node --test tests/supervisor/clear-active-feature-branch.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "clear-branch-data-"));
process.env.BOS_CANONICAL_DATA = dataDir;
const chatsDir = join(dataDir, "vfs", "Documents", "Chats");

const { clearActiveFeatureBranch } = await import("../../tools/supervisor/lib/conversations.mjs");
const { state } = await import("../../tools/supervisor/lib/state.mjs");
const { initLogStore } = await import("../../tools/supervisor/lib/log.mjs");
initLogStore(dataDir);

function writeConversation(id, fields) {
  mkdirSync(chatsDir, { recursive: true });
  writeFileSync(join(chatsDir, `${id}.json`), JSON.stringify({ id, title: "t", createdAt: 1, messages: [], ...fields }, null, 2));
}

function readConversation(id) {
  return JSON.parse(readFileSync(join(chatsDir, `${id}.json`), "utf8"));
}

/** A fake base server recording every PATCH it receives. */
async function makeFakeBase(responder) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      calls.push({ method: req.method, path: req.url, body: parsed });
      const { status, json } = responder(parsed);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, calls, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

test("clearActiveFeatureBranch: only conversations matching the branch get a clear PATCH; others are untouched", async () => {
  rmSync(chatsDir, { recursive: true, force: true });
  writeConversation("match-1", { activeFeatureBranch: "bos/testfixture-gone" });
  writeConversation("match-2", { activeFeatureBranch: "bos/testfixture-gone" });
  writeConversation("no-match", { activeFeatureBranch: "bos/testfixture-still-active" });
  writeConversation("unset", {});

  const fake = await makeFakeBase(() => ({ status: 200, json: { ok: true } }));
  try {
    state.base = { role: "base", state: "ready", port: fake.port };
    const warnings = [];
    await clearActiveFeatureBranch("bos/testfixture-gone", warnings);

    assert.deepEqual(warnings, []);
    const patched = fake.calls.filter((c) => c.method === "PATCH").map((c) => c.body.conversationId).sort();
    assert.deepEqual(patched, ["match-1", "match-2"], "exactly the matching conversations, no others");
    for (const call of fake.calls) assert.equal(call.body.branch, "", "a clear is always branch: \"\"");
  } finally {
    state.base = null;
    await fake.close();
  }
});

test("clearActiveFeatureBranch: no matching conversations means no HTTP calls at all", async () => {
  rmSync(chatsDir, { recursive: true, force: true });
  writeConversation("irrelevant", { activeFeatureBranch: "bos/testfixture-something-else" });

  const fake = await makeFakeBase(() => ({ status: 200, json: { ok: true } }));
  try {
    state.base = { role: "base", state: "ready", port: fake.port };
    const warnings = [];
    await clearActiveFeatureBranch("bos/testfixture-gone", warnings);
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(warnings, []);
  } finally {
    state.base = null;
    await fake.close();
  }
});

test("clearActiveFeatureBranch: base not ready — records a warning, makes no HTTP call, never throws", async () => {
  rmSync(chatsDir, { recursive: true, force: true });
  writeConversation("stuck", { activeFeatureBranch: "bos/testfixture-gone" });

  state.base = null; // no base at all
  const warnings = [];
  await clearActiveFeatureBranch("bos/testfixture-gone", warnings);

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /base is not ready/i);
  assert.equal(readConversation("stuck").activeFeatureBranch, "bos/testfixture-gone", "must be untouched — the clear could not be safely performed");
});

test("clearActiveFeatureBranch: base API call fails (network error) — recorded as a warning, not thrown", async () => {
  rmSync(chatsDir, { recursive: true, force: true });
  writeConversation("errors-out", { activeFeatureBranch: "bos/testfixture-gone" });

  state.base = { role: "base", state: "ready", port: 1 }; // port 1 is always refused — deterministic connection failure
  const warnings = [];
  await clearActiveFeatureBranch("bos/testfixture-gone", warnings);

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /clearing activeFeatureBranch on conversation errors-out via base API failed/);
  state.base = null;
});

test("clearActiveFeatureBranch: base responds ok:false — recorded as a warning, not thrown, and other matches still get their own attempt", async () => {
  rmSync(chatsDir, { recursive: true, force: true });
  writeConversation("rejected", { activeFeatureBranch: "bos/testfixture-gone" });
  writeConversation("accepted", { activeFeatureBranch: "bos/testfixture-gone" });

  const fake = await makeFakeBase((body) => (body.conversationId === "rejected" ? { status: 400, json: { ok: false, error: "boom" } } : { status: 200, json: { ok: true } }));
  try {
    state.base = { role: "base", state: "ready", port: fake.port };
    const warnings = [];
    await clearActiveFeatureBranch("bos/testfixture-gone", warnings);

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /rejected/);
    assert.match(warnings[0], /boom/);
    const attempted = fake.calls.map((c) => c.body.conversationId).sort();
    assert.deepEqual(attempted, ["accepted", "rejected"], "one conversation's rejection must not stop the others from being attempted");
  } finally {
    state.base = null;
    await fake.close();
  }
});

test("clearActiveFeatureBranch: no Chats directory at all — silent no-op, no warnings", async () => {
  rmSync(chatsDir, { recursive: true, force: true });
  state.base = { role: "base", state: "ready", port: 1 };
  const warnings = [];
  await clearActiveFeatureBranch("bos/testfixture-gone", warnings);
  assert.deepEqual(warnings, []);
  state.base = null;
});

test.after(() => rmSync(dataDir, { recursive: true, force: true }));
