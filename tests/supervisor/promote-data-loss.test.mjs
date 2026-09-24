// Fix C regression: promote destroys the preview's data clone, which silently
// drops any per-item service runtime config (API key in secret.json, settings in
// config.json) set in preview. `scanDataLossWarnings` must detect each divergent
// file (absent on base, or different content) and emit a structured warning so
// the user is told to re-configure on base. This is a warning, never a
// data-carry — base stays canonical (ADR-c).
//
// Tests the exported diff function in isolation (real fs, tmp dirs, no git, no
// network, no server). The env is stood up with makeSupervisorEnv BEFORE the
// promote.mjs import because config.mjs freezes its env-derived constants at
// first import.
//
//   node --test tests/supervisor/promote-data-loss.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { makeSupervisorEnv } from "./_data-helpers.mjs";

const env = makeSupervisorEnv("promote-dataloss-");
const { scanDataLossWarnings } = await import("../../tools/supervisor/lib/promote.mjs");

/** Write per-item service config files under <dir>/system/config/<item>/data/. */
function seed(dir, items) {
  for (const [item, files] of Object.entries(items)) {
    for (const [name, content] of Object.entries(files)) {
      const p = join(dir, "system", "config", item, "data", name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
  }
}

test("candidate secret+config present, base has neither -> one entry listing both files", async () => {
  const cand = env.clones + "/cand";
  const base = env.dataDir + "/base";
  seed(cand, { "test-item": { "secret.json": '{"providers":{"twelvedata":"K"}}', "config.json": '{"watchlist":["X"]}' } });
  // base dir exists but has no service config for test-item

  const warnings = await scanDataLossWarnings(cand, base);
  assert.equal(warnings.length, 1, "exactly one divergent item");
  const w = warnings[0];
  assert.equal(w.item, "test-item");
  assert.deepEqual(w.files.sort(), ["config.json", "secret.json"], "both files flagged");
  assert.match(w.message, /test-item/);
  assert.match(w.message, /will NOT be promoted/);
});

test("content differs (base has the file but different) -> flagged; identical -> not flagged", async () => {
  const cand = env.clones + "/cand2";
  const base = env.dataDir + "/base2";
  const same = '{"thresholds":{"baseMinDuration":60}}';
  seed(cand, { "test-item": { "secret.json": '{"providers":{"twelvedata":"NEW"}}', "config.json": same } });
  seed(base, { "test-item": { "secret.json": '{"providers":{"twelvedata":"OLD"}}', "config.json": same } });

  const warnings = await scanDataLossWarnings(cand, base);
  assert.equal(warnings.length, 1, "only the divergent file's item is reported");
  assert.deepEqual(warnings[0].files, ["secret.json"], "the identical config.json is NOT flagged");
});

test("no divergence (identical or absent in preview) -> empty warnings", async () => {
  const cand = env.clones + "/cand3";
  const base = env.dataDir + "/base3";
  const same = '{"watchlist":[]}';
  seed(cand, { "test-item": { "config.json": same } });
  seed(base, { "test-item": { "config.json": same } });
  // a second item exists in the preview but has nothing set (empty data dir)
  mkdirSync(join(cand, "system", "config", "other-item", "data"), { recursive: true });

  const warnings = await scanDataLossWarnings(cand, base);
  assert.deepEqual(warnings, [], "identical content and empty items produce no warning");
});

test("a missing base data root is not an error (all preview config is divergent)", async () => {
  const cand = env.clones + "/cand4";
  const base = env.dataDir + "/base-missing"; // intentionally never created
  seed(cand, { "test-item": { "secret.json": '{"providers":{"twelvedata":"K"}}' } });

  const warnings = await scanDataLossWarnings(cand, base);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0].files, ["secret.json"]);
});

test.after(() => {
  env.cleanup();
});
