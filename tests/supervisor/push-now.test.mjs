// Unit tests for tools/supervisor/lib/push.mjs's pushNow/pushOriginViaBaseApi
// — the per-remote "Push" button path, which delegates to base's own
// /api/git-remotes route (the Supervisor has no credential access of its
// own for this path; see the doc comment on pushOriginViaBaseApi).
//   node --test tests/supervisor/push-now.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const { pushNow } = await import("../../tools/supervisor/lib/push.mjs");
const { state } = await import("../../tools/supervisor/lib/state.mjs");

async function makeFakeBase(responder) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      calls.push(parsed);
      const { status, json } = responder(parsed);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { calls, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

test("pushNow: base not ready — throws without any HTTP call", async () => {
  state.base = null;
  state.baseBranch = "claude";
  await assert.rejects(pushNow(), /Base is not ready/);
});

test("pushNow: success — posts the expected action/name/branch and returns { pushed }", async () => {
  const fake = await makeFakeBase(() => ({ status: 200, json: { ok: true } }));
  try {
    state.base = { role: "base", state: "ready", port: fake.port };
    state.baseBranch = "claude";
    const result = await pushNow();
    assert.deepEqual(result, { pushed: "claude" });
    assert.deepEqual(fake.calls, [{ action: "push", name: "origin", branch: "claude" }]);
  } finally {
    state.base = null;
    await fake.close();
  }
});

test("pushNow: base API responds with an error field — throws that message", async () => {
  const fake = await makeFakeBase(() => ({ status: 200, json: { error: "no credential configured" } }));
  try {
    state.base = { role: "base", state: "ready", port: fake.port };
    state.baseBranch = "claude";
    await assert.rejects(pushNow(), /no credential configured/);
  } finally {
    state.base = null;
    await fake.close();
  }
});

test("pushNow: base API responds with a non-OK HTTP status and no error field — throws a generic HTTP error", async () => {
  const fake = await makeFakeBase(() => ({ status: 500, json: {} }));
  try {
    state.base = { role: "base", state: "ready", port: fake.port };
    state.baseBranch = "claude";
    await assert.rejects(pushNow(), /failed with HTTP 500/);
  } finally {
    state.base = null;
    await fake.close();
  }
});

test("pushNow: rebaseConflict — throws the base API's own conflict message", async () => {
  const fake = await makeFakeBase(() => ({ status: 200, json: { ok: true, rebaseConflict: true, message: "rebase conflicted, resolve manually" } }));
  try {
    state.base = { role: "base", state: "ready", port: fake.port };
    state.baseBranch = "claude";
    await assert.rejects(pushNow(), /rebase conflicted, resolve manually/);
  } finally {
    state.base = null;
    await fake.close();
  }
});

test("pushNow: unrelatedHistory — throws the base API's own message", async () => {
  const fake = await makeFakeBase(() => ({ status: 200, json: { ok: true, unrelatedHistory: true, message: "no shared history with the remote" } }));
  try {
    state.base = { role: "base", state: "ready", port: fake.port };
    state.baseBranch = "claude";
    await assert.rejects(pushNow(), /no shared history with the remote/);
  } finally {
    state.base = null;
    await fake.close();
  }
});

test("pushNow: base unreachable (connection refused) — the fetch failure propagates", async () => {
  state.base = { role: "base", state: "ready", port: 1 }; // port 1 is always refused
  state.baseBranch = "claude";
  try {
    await assert.rejects(pushNow());
  } finally {
    state.base = null;
  }
});
