// 045 T013 — multi-root agent discovery (FR-001, FR-001a, FR-001b, SC-006, SC-008).
//   npm run test:unit -- tests/agent/agent-roots.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { useTestDataDir } from "../services/_test-env";
import {
  registerPackAgentRoot, unregisterPackAgentRoot, __resetPackAgentRootsForTest, agentRoots, collisionsAmong, seedWriteRoot,
} from "../../src/lib/agent/subagents/roots";
import { listSubAgents, listDelegatableAgents, getAgent, agentRootCollisions } from "../../src/lib/agent/subagents/store";

function writeAgent(root: string, id: string, name: string): void {
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, "AGENT.md"), `---\nname: ${name}\ntype: local\ntools: [file_read]\n---\n\nBody for ${name}.\n`);
}

test("precedence: data/ shadows a pack, a pack shadows seed/", async () => {
  const { dir, cleanup } = useTestDataDir("agent-roots-precedence");
  try {
    __resetPackAgentRootsForTest();
    const packRoot = join(dir, "pack-a", "agents");
    writeAgent(join(dir, "agents"), "architect", "Local Architect");
    writeAgent(packRoot, "architect", "Pack Architect");
    registerPackAgentRoot({ packId: "pack-a", path: packRoot, label: "Pack A" });

    const architect = (await listSubAgents()).find((a) => a.id === "architect");
    expect(architect?.name, "a local copy must win — a user edit is never shadowed by a pack").toBe("Local Architect");
    expect(architect?.sourceRoot).toBe("This deployment");
  } finally {
    __resetPackAgentRootsForTest();
    cleanup();
  }
});

test("a pack's agent is discovered, tagged with its contributing root", async () => {
  const { dir, cleanup } = useTestDataDir("agent-roots-pack");
  try {
    __resetPackAgentRootsForTest();
    const packRoot = join(dir, "bmad", "agents");
    writeAgent(packRoot, "sally", "Sally");
    registerPackAgentRoot({ packId: "bmad", path: packRoot, label: "BMAD" });

    const sally = (await listSubAgents()).find((a) => a.id === "sally");
    expect(sally?.name).toBe("Sally");
    // FR-002 needs both: the label groups the picker, the id lets a failed
    // delegation name the pack that is no longer installed.
    expect(sally?.sourceRoot).toBe("BMAD");
    expect(sally?.packId).toBe("bmad");
  } finally {
    __resetPackAgentRootsForTest();
    cleanup();
  }
});

test("SC-006 — a delegate-only root is absent from the picker but still delegatable", async () => {
  // Visibility scopes DISCOVERY only. An agent that cannot be delegated to is
  // not hidden, it is broken (FR-001b) — so the two listings must genuinely
  // differ rather than one being a filter over a single source of truth that
  // already dropped it.
  const { dir, cleanup } = useTestDataDir("agent-roots-delegate-only");
  try {
    __resetPackAgentRootsForTest();
    const packRoot = join(dir, "openspec", "agents");
    writeAgent(packRoot, "internal-reviewer", "Internal Reviewer");
    registerPackAgentRoot({ packId: "openspec", path: packRoot, label: "OpenSpec", visibility: "delegate-only" });

    expect((await listSubAgents()).map((a) => a.id)).not.toContain("internal-reviewer");
    expect((await listDelegatableAgents()).map((a) => a.id)).toContain("internal-reviewer");
    // And through getAgent() — the path agent_delegate actually takes. The
    // two assertions above passed while delegation was broken.
    expect(await getAgent("internal-reviewer"), "must be reachable by agent_delegate").toBeDefined();
  } finally {
    __resetPackAgentRootsForTest();
    cleanup();
  }
});

test("FR-001a — two packs offering the same id is REPORTED, not silently resolved", async () => {
  const { dir, cleanup } = useTestDataDir("agent-roots-collision");
  try {
    __resetPackAgentRootsForTest();
    for (const [pack, label] of [["a-pack", "A Pack"], ["b-pack", "B Pack"]] as const) {
      const root = join(dir, pack, "agents");
      writeAgent(root, "architect", `${label} Architect`);
      registerPackAgentRoot({ packId: pack, path: root, label });
    }
    const collisions = await agentRootCollisions();
    expect(collisions.map((c) => c.id)).toContain("architect");
    expect(collisions.find((c) => c.id === "architect")?.roots).toEqual(["A Pack", "B Pack"]);
  } finally {
    __resetPackAgentRootsForTest();
    cleanup();
  }
});

test("FR-002a — ONE total order over four levels, packs sorted by PACK ID", () => {
  // Install order varies per machine, so resolving a collision by it would make
  // "which agent did I get" depend on history nobody can inspect.
  //
  // 048 inserted the OVERLAY as level 2, so each pack now contributes TWO roots:
  // its overlay (customisations) above its own root. Asserted as the full
  // ordered list rather than a filter, so a future level cannot be added
  // without this test noticing.
  const { cleanup } = useTestDataDir("agent-roots-order");
  try {
    __resetPackAgentRootsForTest();
    registerPackAgentRoot({ packId: "zeta", path: "/tmp/z", label: "Zeta" });
    registerPackAgentRoot({ packId: "alpha", path: "/tmp/a", label: "Alpha" });

    expect(agentRoots().map((r) => r.label)).toEqual([
      "This deployment",            // 1 — a hand-written BOS agent is the final word
      "Alpha (customised)",         // 2 — overlays, sorted by pack id
      "Zeta (customised)",
      "Alpha",                      // 3 — pack roots, sorted by pack id
      "Zeta",
      "BrowserOS",                  // 4 — what BOS ships
    ]);
  } finally {
    __resetPackAgentRootsForTest();
    cleanup();
  }
});

test("FR-004a — an overlay shadowing ITS OWN pack is not a collision", () => {
  // Every pack has two roots now. Grouping collisions by ROOT would report
  // every customised agent as colliding with the pack it customises — which is
  // the designed behaviour, not a conflict. A collision is two DIFFERENT packs.
  const mk = (label: string, packId?: string) => ({
    root: { kind: "dir" as const, path: "/x", visibility: "picker" as const, label, ...(packId ? { packId } : {}) },
    ids: ["architect"],
  });
  expect(collisionsAmong([mk("BMAD (customised)", "bmad"), mk("BMAD", "bmad")]), "one pack, two roots").toEqual([]);
  expect(collisionsAmong([mk("BMAD", "bmad"), mk("OpenSpec", "openspec")]).map((c) => c.id), "two packs").toEqual(["architect"]);
});

test("collisions are only reported between PACKS — data/ over seed/ is ordinary layering", () => {
  // BOS shadowing its own seed with a local copy is the `.seed-rev` contract
  // working as designed; reporting it as a conflict would make the real signal
  // useless.
  const bosRoots = [
    { root: { kind: "dir" as const, path: "/d", visibility: "picker" as const, label: "This deployment" }, ids: ["architect"] },
    { root: { kind: "dir" as const, path: "/s", visibility: "picker" as const, label: "BrowserOS" }, ids: ["architect"] },
  ];
  expect(collisionsAmong(bosRoots)).toEqual([]);
});

test("SC-008 — seed reconciliation only ever writes to data/agents/", async () => {
  // applySeedAgent/archiveDroppedSeedAgents resolve through agentsDir(). If a
  // future change routed them through agentRoots() instead, BOS would rewrite
  // files INSIDE an installed item — silently reverting the pack's own content
  // and losing it on the item's next upgrade.
  const { dir, cleanup } = useTestDataDir("agent-roots-seed-write");
  try {
    __resetPackAgentRootsForTest();
    const packRoot = join(dir, "pack", "agents");
    writeAgent(packRoot, "architect", "Pack Architect");
    const before = readFileSync(join(packRoot, "architect", "AGENT.md"), "utf8");
    registerPackAgentRoot({ packId: "pack", path: packRoot, label: "Pack" });

    expect(seedWriteRoot()).toBe(join(dir, "agents"));
    await listSubAgents(); // runs ensureSeed(), i.e. the reconciliation

    expect(readFileSync(join(packRoot, "architect", "AGENT.md"), "utf8"), "a pack's file must be untouched").toBe(before);
    expect(existsSync(join(packRoot, ".archive")), "no archive inside a pack root").toBe(false);
    expect(existsSync(join(packRoot, "architect", ".seed-rev")), "no seed stamp inside a pack root").toBe(false);
  } finally {
    __resetPackAgentRootsForTest();
    cleanup();
  }
});

test("unregistering a pack root removes its agents from discovery", async () => {
  const { dir, cleanup } = useTestDataDir("agent-roots-unregister");
  try {
    __resetPackAgentRootsForTest();
    const packRoot = join(dir, "pack", "agents");
    writeAgent(packRoot, "temp-agent", "Temp");
    registerPackAgentRoot({ packId: "pack", path: packRoot, label: "Pack" });
    expect((await listSubAgents()).map((a) => a.id)).toContain("temp-agent");

    expect(unregisterPackAgentRoot("pack")).toBe(true);
    expect((await listSubAgents()).map((a) => a.id)).not.toContain("temp-agent");
    expect(unregisterPackAgentRoot("pack"), "second removal reports nothing to remove").toBe(false);
  } finally {
    __resetPackAgentRootsForTest();
    cleanup();
  }
});
