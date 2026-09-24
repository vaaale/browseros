// Browser automation v2 — the browser_* tools must actually REACH agents.
//
// Under `empty allowlist = zero tools`, shipping new registry tools does
// nothing for a deployment whose agents were seeded before the tools existed:
// applySeedAgent never overwrites an existing AGENT.md, so a pre-existing
// assistant would silently lack every browser_* id and the feature would look
// broken rather than absent — exactly the failure conflict_* (035) and
// self_heal_* (031) hit before, each fixed by a marker-guarded additive
// backfill. Same mechanism here.
//   npm run test:unit -- tests/agent/browser-tools-backfill.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { readFileSync, writeFileSync, rmSync } from "fs";
import { useTestDataDir } from "../services/_test-env";

/* eslint-disable @typescript-eslint/no-require-imports */
const AGENT_STORE = "../../src/lib/agent/subagents/store";
function agentStore(): typeof import("../../src/lib/agent/subagents/store") {
  delete require.cache[require.resolve(AGENT_STORE)];
  return require(AGENT_STORE) as typeof import("../../src/lib/agent/subagents/store");
}

// The on-disk marker contract (like .conflict-tools-backfilled): pinned as a
// literal so a rename shows up as a failure, not a silently new marker.
const MARKER = ".browser-tools-backfilled";

test("a fresh seed ships the assistant with the browser driving tools", async () => {
  const { dir, cleanup } = useTestDataDir("browser-backfill-fresh");
  try {
    await agentStore().listSubAgents();
    const src = readFileSync(join(dir, "agents", "assistant", "AGENT.md"), "utf8");
    for (const id of ["browser_navigate", "browser_snapshot", "browser_click", "browser_take_screenshot", "browser_close"]) {
      expect(src, `seeded assistant should allow ${id}`).toContain(id);
    }
  } finally {
    cleanup();
  }
});

test("a pre-existing assistant from before the feature gains the tools exactly once", async () => {
  const { dir, cleanup } = useTestDataDir("browser-backfill-legacy");
  try {
    await agentStore().listSubAgents();
    const file = join(dir, "agents", "assistant", "AGENT.md");

    // Simulate the legacy install: an assistant seeded before browser_* existed
    // (no ids in the allowlist, no marker yet).
    const stripped = readFileSync(file, "utf8").replace(/browser_[a-z_]+,?\s*/g, "");
    writeFileSync(file, stripped);
    rmSync(join(dir, "agents", "assistant", MARKER), { force: true });

    await agentStore().listSubAgents();
    const after = readFileSync(file, "utf8");
    expect(after).toContain("browser_navigate");
    expect(after).toContain("browser_take_screenshot");
  } finally {
    cleanup();
  }
});

test("a user who removes a browser tool after the backfill keeps it removed", async () => {
  const { dir, cleanup } = useTestDataDir("browser-backfill-optout");
  try {
    await agentStore().listSubAgents();
    const file = join(dir, "agents", "assistant", "AGENT.md");

    // The user deliberately drops one browser tool AFTER the backfill ran
    // (the marker exists). The backfill must never fight that decision.
    const withoutEvaluate = readFileSync(file, "utf8").replace(/browser_evaluate,?\s*/g, "");
    writeFileSync(file, withoutEvaluate);

    await agentStore().listSubAgents();
    const after = readFileSync(file, "utf8");
    expect(after).not.toContain("browser_evaluate");
    expect(after).toContain("browser_navigate");
  } finally {
    cleanup();
  }
});
