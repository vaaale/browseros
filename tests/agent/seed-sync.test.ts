// Unit tests for seed reconciliation (src/lib/agent/seed-sync.ts and its two
// consumers, subagents/store.ts and skills/store.ts).
//
// `seed/` used to be a first-boot template: a seeded id was written into data/
// only when absent, so a shipped improvement to an existing skill — or a
// deletion — never reached a deployment that had already booted. The fix has to
// update BOS's own untouched copies WITHOUT ever clobbering one that
// skill_improve or the user has edited, which is what the .seed-rev stamp
// exists to distinguish.
//
// Coverage split: `decideSeedAction` is exercised directly (both stores route
// every verdict through it), and the store wiring is exercised end-to-end on
// the agent side, where a revision is a plain hash of the file's bytes and a
// prior revision can therefore be simulated honestly. The skill side asserts
// the two properties that don't depend on faking a stamp — a fresh seed lands
// stamped, and a locally edited skill is never written to. Simulating "the
// shipped skill moved on" would mean either mutating BOS's real seed/ tree
// (which is source, not fixture) or re-implementing the asset hash layout in
// the test, and neither is worth it for a path the decision table already pins.
//   npm run test:unit -- tests/agent/seed-sync.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { useTestDataDir } from "../services/_test-env";
import { decideSeedAction, seedRev } from "../../src/lib/agent/seed-sync";

test("decision table: only a stamped, unedited copy is ever written to", () => {
  const SEED = seedRev(["shipped"]);
  const SEED2 = seedRev(["shipped v2"]);
  // What BOS wrote — deliberately NOT equal to the seed hash, because the
  // stores re-serialize (skills) or migrate (agents) after writing.
  const WROTE = seedRev(["shipped, as written to disk"]);
  const EDITED = seedRev(["locally edited"]);
  const stamp = { seed: SEED, live: WROTE };

  // Absent → seed it (the original additive behaviour).
  expect(decideSeedAction({ inSeed: true, seedRev: SEED })).toBe("seed");
  // Untouched and the seed moved on → update.
  expect(decideSeedAction({ inSeed: true, liveRev: WROTE, stamp, seedRev: SEED2 })).toBe("update");
  // Untouched and already current → no write.
  expect(decideSeedAction({ inSeed: true, liveRev: WROTE, stamp, seedRev: SEED })).toBe("current");
  // Edited since BOS wrote it → never touched, even though the seed moved on.
  expect(decideSeedAction({ inSeed: true, liveRev: EDITED, stamp, seedRev: SEED2 })).toBe("local");
  // Unstamped (predates the mechanism) → unprovable, so treated as local.
  expect(decideSeedAction({ inSeed: true, liveRev: WROTE, seedRev: SEED2 })).toBe("local");
  // Dropped from seed: archive only the provably untouched one.
  expect(decideSeedAction({ inSeed: false, liveRev: WROTE, stamp })).toBe("archive");
  expect(decideSeedAction({ inSeed: false, liveRev: EDITED, stamp })).toBe("local");
  expect(decideSeedAction({ inSeed: false, liveRev: WROTE })).toBe("local");
});

test("the two stamp halves are compared independently", () => {
  // Regression: the first version of this used ONE hash for both questions.
  // Because what BOS writes is never byte-identical to the seed, every id then
  // read as locally modified the moment it was written and nothing ever
  // updated — the mechanism silently did nothing. Here `live` matches disk
  // while `seed` does not match the current seed: that is exactly "untouched,
  // and the shipped version moved on", i.e. an update.
  const stamp = { seed: seedRev(["seed v1"]), live: seedRev(["written v1"]) };
  expect(decideSeedAction({ inSeed: true, liveRev: stamp.live, stamp, seedRev: seedRev(["seed v2"]) })).toBe("update");
});

test("the hash covers a skill's assets, not just SKILL.md", () => {
  // The change that motivated this lived entirely in a reference document.
  expect(seedRev(["SKILL", "references/x.md", "one"])).not.toBe(seedRev(["SKILL", "references/x.md", "two"]));
  // Length-prefixing: regrouping the same bytes must not collide.
  expect(seedRev(["ab", "c"])).not.toBe(seedRev(["a", "bc"]));
});

// ── End-to-end through the real stores ───────────────────────────────────────
// Both stores memoize seeding in a module-level flag AND resolve their data
// directory at module scope, so each case needs a genuinely fresh module —
// dropping it from the require cache gives one that also picks up this test's
// BOS_DATA_DIR. seed/ itself is BOS source, driven as-is.
/* eslint-disable @typescript-eslint/no-require-imports */
const AGENT_STORE = "../../src/lib/agent/subagents/store";
const SKILL_STORE = "../../src/lib/agent/skills/store";

function reload<T>(mod: string): T {
  delete require.cache[require.resolve(mod)];
  return require(mod) as T;
}
const agentStore = () => reload<typeof import("../../src/lib/agent/subagents/store")>(AGENT_STORE);
const skillStore = () => reload<typeof import("../../src/lib/agent/skills/store")>(SKILL_STORE);

test("an untouched seeded agent is refreshed when the shipped copy changes", async () => {
  const { dir, cleanup } = useTestDataDir("seed-sync-agent-update");
  try {
    await agentStore().listSubAgents();
    const agentDir = join(dir, "agents", "researcher");
    const live = join(agentDir, "AGENT.md");
    const shipped = readFileSync(live, "utf8");

    // The stamp records BOS's final bytes — which include the allowlist the
    // backfill migration adds after seeding, NOT the raw seed file.
    const stamp = JSON.parse(readFileSync(join(agentDir, ".seed-rev"), "utf8")) as { seed: string; live: string };
    expect(stamp.live).toBe(seedRev([shipped]));
    expect(stamp.seed).not.toBe(stamp.live);

    // Rewind to an older revision BOS wrote and nobody edited: older bytes,
    // with `live` pointing at those bytes and `seed` at a superseded revision.
    const older = "---\nname: Researcher\ntype: local\n---\nolder shipped text\n";
    writeFileSync(live, older);
    writeFileSync(join(agentDir, ".seed-rev"), JSON.stringify({ seed: seedRev(["older seed"]), live: seedRev([older]) }));

    await agentStore().listSubAgents();
    expect(readFileSync(live, "utf8")).toBe(shipped);
    // …and the refreshed agent kept its tool allowlist: the update clears the
    // one-shot migration markers so the backfill re-applies over the seed's
    // own frontmatter, which carries no `tools` field.
    expect(readFileSync(live, "utf8")).toContain("tools: [");
  } finally {
    cleanup();
  }
});

test("a locally edited seeded agent is never overwritten", async () => {
  const { dir, cleanup } = useTestDataDir("seed-sync-agent-local");
  try {
    await agentStore().listSubAgents();
    // Edit in place, leaving the stamp on the shipped revision — the exact
    // shape of a Settings edit or a skill_improve-style rewrite.
    const live = join(dir, "agents", "researcher", "AGENT.md");
    writeFileSync(live, "---\nname: Researcher\ntype: local\n---\nMY OWN PROMPT\n");

    await agentStore().listSubAgents();
    expect(readFileSync(live, "utf8")).toContain("MY OWN PROMPT");
  } finally {
    cleanup();
  }
});

test("an untouched agent dropped from seed/ is archived, not deleted", async () => {
  const { dir, cleanup } = useTestDataDir("seed-sync-agent-archive");
  try {
    await agentStore().listSubAgents();

    const body = "---\nname: Retired\ntype: local\n---\nbody\n";
    const gone = join(dir, "agents", "retired-agent");
    mkdirSync(gone, { recursive: true });
    writeFileSync(join(gone, "AGENT.md"), body);
    writeFileSync(join(gone, ".seed-rev"), JSON.stringify({ seed: seedRev(["whatever"]), live: seedRev([body]) }));

    const agents = await agentStore().listSubAgents();
    expect(agents.some((a) => a.id === "retired-agent")).toBe(false);
    expect(existsSync(join(dir, "agents", ".archive", "retired-agent", "AGENT.md"))).toBe(true);
    expect(existsSync(gone)).toBe(false);
  } finally {
    cleanup();
  }
});

test("an agent the user created is left alone when it isn't in seed/", async () => {
  const { dir, cleanup } = useTestDataDir("seed-sync-agent-usermade");
  try {
    await agentStore().listSubAgents();

    // No .seed-rev — never came from seed, so not BOS's to archive.
    const mine = join(dir, "agents", "my-agent");
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, "AGENT.md"), "---\nname: Mine\ntype: local\n---\nbody\n");

    expect((await agentStore().listSubAgents()).some((a) => a.id === "my-agent")).toBe(true);
  } finally {
    cleanup();
  }
});

test("EVERY seeded agent and skill lands with a stamp that matches its bytes on disk", async () => {
  const { dir, cleanup } = useTestDataDir("seed-sync-stamp-coverage");
  try {
    await agentStore().listSubAgents();
    await skillStore().listSkills();

    // Not a sample: every id the seed ships must end up tracked, including
    // default_agent (skipped by the allowlist backfill) and every agent the
    // backfills DO rewrite. An id seeded but left unstamped would read as
    // "local" forever and silently never update again.
    const checked: string[] = [];
    for (const [store, seedRoot, file] of [
      ["agents", join(process.cwd(), "seed", "agents"), "AGENT.md"],
      ["skills", join(process.cwd(), "seed", "skills"), "SKILL.md"],
    ] as const) {
      for (const entry of readdirSync(seedRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !existsSync(join(seedRoot, entry.name, file))) continue;
        // Skills are keyed by slugified display name, not folder name.
        const ids = readdirSync(join(dir, store)).filter((n) => !n.startsWith("."));
        const id = ids.includes(entry.name) ? entry.name : undefined;
        if (!id) continue; // resolved to a different id; covered by the count assertion below
        const stampFile = join(dir, store, id, ".seed-rev");
        expect(existsSync(stampFile), `${store}/${id} has no stamp`).toBe(true);
        const stamp = JSON.parse(readFileSync(stampFile, "utf8")) as { seed: string; live: string };
        expect(stamp.seed, `${store}/${id} stamp.seed`).toBeTruthy();
        if (store === "agents") {
          expect(stamp.live, `${store}/${id} stamp.live must match disk`).toBe(seedRev([readFileSync(join(dir, store, id, "AGENT.md"), "utf8")]));
        }
        checked.push(`${store}/${id}`);
      }
    }
    expect(checked.length).toBeGreaterThan(10);

    // Second boot must be a no-op: every id resolves to "current", so nothing
    // is rewritten and no stamp changes.
    const before = checked.map((k) => readFileSync(join(dir, k, ".seed-rev"), "utf8"));
    await agentStore().listSubAgents();
    await skillStore().listSkills();
    expect(checked.map((k) => readFileSync(join(dir, k, ".seed-rev"), "utf8"))).toEqual(before);
  } finally {
    cleanup();
  }
});

test("a seeded skill lands stamped, with its reference documents", async () => {
  const { dir, cleanup } = useTestDataDir("seed-sync-skill-seed");
  try {
    await skillStore().listSkills();
    expect(existsSync(join(dir, "skills", "build-studio", ".seed-rev"))).toBe(true);
    // Reference assets are part of the seeded skill, and part of its revision.
    expect(readFileSync(join(dir, "skills", "build-studio", "references", "target-marketplace-item.md"), "utf8")).toContain("docs/` facet");
  } finally {
    cleanup();
  }
});

test("a locally edited skill is never overwritten by re-seeding", async () => {
  const { dir, cleanup } = useTestDataDir("seed-sync-skill-local");
  try {
    await skillStore().listSkills();
    const live = join(dir, "skills", "build-studio", "SKILL.md");
    writeFileSync(live, "---\nname: Build Studio\n---\nMY OWN SKILL BODY\n");

    await skillStore().listSkills();
    expect(readFileSync(live, "utf8")).toContain("MY OWN SKILL BODY");
  } finally {
    cleanup();
  }
});
