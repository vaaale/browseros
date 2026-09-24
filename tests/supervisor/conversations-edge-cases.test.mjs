// Unit tests for the remaining branches of
// tools/supervisor/lib/conversations.mjs's clearActiveFeatureBranch not
// already covered by clear-active-feature-branch.test.mjs: a genuine
// (non-ENOENT) failure reading the Chats directory, and a malformed
// conversation JSON file among otherwise-valid ones.
// Own process — see that file's header comment on why (CANONICAL_DATA is
// frozen by config.mjs at first import).
//   node --test tests/supervisor/conversations-edge-cases.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "conv-edge-data-"));
process.env.BOS_CANONICAL_DATA = dataDir;
const vfsDocsDir = join(dataDir, "vfs", "Documents");
const chatsDir = join(vfsDocsDir, "Chats");

const { clearActiveFeatureBranch } = await import("../../tools/supervisor/lib/conversations.mjs");
const { state } = await import("../../tools/supervisor/lib/state.mjs");
const { initLogStore } = await import("../../tools/supervisor/lib/log.mjs");
initLogStore(dataDir);

test("clearActiveFeatureBranch: a genuine (non-ENOENT) failure reading the Chats dir is recorded as a warning, not thrown", async () => {
  rmSync(chatsDir, { recursive: true, force: true });
  mkdirSync(vfsDocsDir, { recursive: true });
  // A FILE where a directory is expected -> ENOTDIR, not ENOENT.
  writeFileSync(chatsDir, "not a directory");
  try {
    state.base = { role: "base", state: "ready", port: 1 };
    const warnings = [];
    await clearActiveFeatureBranch("bos/testfixture-gone", warnings);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /activeFeatureBranch was not cleared on any conversation/);
  } finally {
    state.base = null;
    rmSync(chatsDir, { force: true });
  }
});

test("clearActiveFeatureBranch: a malformed conversation JSON file is warned about; other valid matches are still cleared", async () => {
  rmSync(chatsDir, { recursive: true, force: true });
  mkdirSync(chatsDir, { recursive: true });
  writeFileSync(join(chatsDir, "corrupt.json"), "{ not valid json");
  writeFileSync(join(chatsDir, "valid.json"), JSON.stringify({ id: "valid", activeFeatureBranch: "bos/testfixture-gone" }));

  const http = await import("node:http");
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      calls.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    state.base = { role: "base", state: "ready", port: server.address().port };
    const warnings = [];
    await clearActiveFeatureBranch("bos/testfixture-gone", warnings);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /reading corrupt\.json to check its active branch failed/);
    assert.deepEqual(calls.map((c) => c.conversationId), ["valid"], "the malformed file must not block clearing the valid one");
  } finally {
    state.base = null;
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(() => rmSync(dataDir, { recursive: true, force: true }));
