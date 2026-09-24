// 048 T003/T004 — provider agent roots (FR-001, FR-002, FR-003, US1, US2).
//
// A provider produces agents from a pure function instead of `AGENT.md` files,
// so a framework defining its cast in its OWN format (BMAD's YAML) works
// without rewriting it into BOS format at install — which would break 035's
// "install copies nothing" and create a derived cache with no invalidation
// point.
//   npm run test:unit -- tests/agent/provider-roots.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, readdirSync, utimesSync } from "fs";
import { useTestDataDir } from "../services/_test-env";
import {
  registerAgentProvider, unregisterAgentProvider, registerPackAgentRoot,
  __resetPackAgentRootsForTest, agentRoots, type ProviderOutput,
} from "../../src/lib/agent/subagents/roots";
import { listSubAgents, listDelegatableAgents, getAgent, __resetProviderCacheForTest } from "../../src/lib/agent/subagents/store";
import type { Agent } from "../../src/lib/agent/subagents/types";

function agent(id: string, name = id): Agent {
  return { id, name, description: `Provided ${id}`, type: "local", systemPrompt: `Body for ${id}.` };
}

function reset(): void {
  __resetPackAgentRootsForTest();
  __resetProviderCacheForTest();
}

test("US1 — a provider's agents are discovered, with NO files emitted anywhere", async () => {
  const { dir, cleanup } = useTestDataDir("provider-discovery");
  try {
    reset();
    // Let BOS's OWN seeding run first and snapshot AFTER it. Snapshotting
    // before would attribute data/agents/ and data/skills/ — created by
    // ensureSeed, not by any provider — to the provider, and the assertion
    // would fail for a reason that has nothing to do with FR-001.
    await listSubAgents();
    const before = JSON.stringify(readdirSync(dir).sort());

    registerAgentProvider({
      kind: "provider", packId: "bmad", label: "BMAD", visibility: "picker",
      watch: [], resolve: async () => ({ agents: [agent("analyst"), agent("pm")] }),
    });

    const ids = (await listSubAgents()).map((a) => a.id);
    expect(ids).toContain("analyst");
    expect(ids).toContain("pm");

    // FR-001's hard constraint: resolve() is PURE. If it ever writes, 035's
    // "install copies nothing" is broken and a staleness class appears with no
    // natural invalidation point.
    expect(JSON.stringify(readdirSync(dir).sort()), "resolving a provider must create nothing on disk").toBe(before);

    const analyst = (await listSubAgents()).find((a) => a.id === "analyst");
    expect(analyst?.sourceRoot, "tagged with its contributing root, like any pack agent").toBe("BMAD");
    expect(analyst?.packId).toBe("bmad");
  } finally {
    reset();
    cleanup();
  }
});

test("providers and directory roots share ONE ordering, sorted by pack id", () => {
  // Not two tiers. A provider-backed pack and a file-backed one must interleave
  // deterministically, or "which agent did I get" depends on which mechanism
  // the pack happened to use.
  reset();
  const { cleanup } = useTestDataDir("provider-order");
  try {
    registerAgentProvider({ kind: "provider", packId: "zeta", label: "Zeta", visibility: "picker", watch: [], resolve: async () => ({ agents: [] }) });
    registerPackAgentRoot({ packId: "alpha", path: "/tmp/a", label: "Alpha" });
    // Each pack contributes its overlay (level 2) then its own root (level 3),
    // and the two KINDS interleave by pack id within each level rather than
    // forming separate tiers.
    expect(agentRoots().filter((r) => r.packId).map((r) => `${r.packId}:${r.kind}`)).toEqual([
      "alpha:dir", "zeta:dir",      // level 2 — overlays are always directories
      "alpha:dir", "zeta:provider", // level 3 — the pack's own root, either kind
    ]);
  } finally {
    reset();
    cleanup();
  }
});

test("SC-003 — a delegate-only provider is absent from the picker, still delegatable", async () => {
  const { cleanup } = useTestDataDir("provider-delegate-only");
  try {
    reset();
    registerAgentProvider({
      kind: "provider", packId: "bmm", label: "BMad Method", visibility: "delegate-only",
      watch: [], resolve: async () => ({ agents: [agent("sm"), agent("po")] }),
    });
    // BMM's cast is chain-dependent — Sally without a prd.md has no input and
    // no consumer — so eight personas in the picker would bury the agents a
    // user actually starts conversations with.
    expect((await listSubAgents()).map((a) => a.id)).not.toContain("sm");
    expect((await listDelegatableAgents()).map((a) => a.id)).toContain("sm");

    // THE PATH A REAL DELEGATION TAKES. `agent_delegate` resolves through
    // getAgent(), not through the listing above — and getAgent went through
    // listSubAgents(), which filters to picker-visible roots. So every
    // delegate-only agent was absent from the picker AND unreachable by
    // delegation: undeliverable, which is precisely the failure FR-001b names.
    //
    // The original version of this test asserted only the two lines above, so
    // it passed while the feature was broken. Asserting the listing function
    // you just wrote is not the same as asserting the route the feature uses.
    expect(await getAgent("sm"), "agent_delegate must resolve a delegate-only agent").toBeDefined();
    expect((await getAgent("sm"))?.name).toBe("sm");
  } finally {
    reset();
    cleanup();
  }
});

test("US2 — a newly authored agent appears with NO restart, and the cache does not serve it stale", async () => {
  // The reason resolve() is invoked at discovery rather than parsed at boot.
  // Boot parsing would make BMAD agents the one kind requiring a bounce —
  // worst precisely for BMB, whose purpose is authoring agents interactively.
  const { dir, cleanup } = useTestDataDir("provider-no-restart");
  try {
    reset();
    const watched = join(dir, "packroot");
    mkdirSync(watched, { recursive: true });
    writeFileSync(join(watched, "cast.yaml"), "agents: [analyst]\n");

    let calls = 0;
    registerAgentProvider({
      kind: "provider", packId: "bmb", label: "BMad Builder", visibility: "picker", watch: [watched],
      resolve: async () => {
        calls++;
        const names = readdirSync(watched).filter((f) => f.endsWith(".yaml")).map((f) => f.replace(".yaml", ""));
        return { agents: names.map((n) => agent(n)) } as ProviderOutput;
      },
    });

    expect((await listSubAgents()).map((a) => a.id)).toContain("cast");
    const afterFirst = calls;

    // Unchanged inputs ⇒ served from cache, not re-resolved.
    await listSubAgents();
    expect(calls, "an unchanged pack must not re-resolve").toBe(afterFirst);

    // BMB writes a new agent. It must appear on the NEXT call — no restart.
    writeFileSync(join(watched, "reviewer.yaml"), "agents: [reviewer]\n");
    const future = Date.now() / 1000 + 5;
    utimesSync(watched, future, future); // make the change unambiguous to the mtime scan

    const ids = (await listSubAgents()).map((a) => a.id);
    expect(ids, "a newly authored agent resolves without a restart").toContain("reviewer");
    expect(calls, "and the provider was actually re-invoked").toBeGreaterThan(afterFirst);
  } finally {
    reset();
    cleanup();
  }
});

test("R4 — an ambiguous mtime scan RE-RESOLVES rather than serving a stale result", async () => {
  // Correctness, not performance. A stale entry means an agent BMB just
  // authored does not appear, which reads as BMB being broken. An empty
  // `watch` (nothing to key on) and an unreadable path are both ambiguous.
  const { cleanup } = useTestDataDir("provider-ambiguous");
  try {
    reset();
    let calls = 0;
    registerAgentProvider({
      kind: "provider", packId: "p", label: "P", visibility: "picker",
      watch: [], // nothing to key on
      resolve: async () => { calls++; return { agents: [agent(`a${calls}`)] }; },
    });
    await listSubAgents();
    await listSubAgents();
    expect(calls, "with nothing to key on, never cache").toBe(2);

    reset();
    calls = 0;
    registerAgentProvider({
      kind: "provider", packId: "q", label: "Q", visibility: "picker",
      watch: ["/nonexistent/path/that/cannot/be/stat-ed"],
      resolve: async () => { calls++; return { agents: [agent("x")] }; },
    });
    await listSubAgents();
    await listSubAgents();
    expect(calls, "an unreadable watch path is ambiguous ⇒ re-resolve").toBe(2);
  } finally {
    reset();
    cleanup();
  }
});

test("a throwing provider degrades to no agents rather than taking discovery down", async () => {
  // One pack's broken provider must not blank the whole agent list — the same
  // containment reasoning as a store bound to a missing method.
  const { cleanup } = useTestDataDir("provider-throws");
  try {
    reset();
    registerAgentProvider({
      kind: "provider", packId: "broken", label: "Broken", visibility: "picker",
      watch: [], resolve: async () => { throw new Error("pack is malformed"); },
    });
    await expect(listSubAgents()).resolves.toBeDefined();
    expect((await listSubAgents()).every((a) => a.packId !== "broken")).toBe(true);
  } finally {
    reset();
    cleanup();
  }
});

test("unregistering a provider removes its agents", async () => {
  const { cleanup } = useTestDataDir("provider-unregister");
  try {
    reset();
    registerAgentProvider({
      kind: "provider", packId: "tmp", label: "Tmp", visibility: "picker",
      watch: [], resolve: async () => ({ agents: [agent("ghost")] }),
    });
    expect((await listSubAgents()).map((a) => a.id)).toContain("ghost");
    expect(unregisterAgentProvider("tmp")).toBe(true);
    expect((await listSubAgents()).map((a) => a.id)).not.toContain("ghost");
    expect(unregisterAgentProvider("tmp"), "second removal reports nothing to remove").toBe(false);
  } finally {
    reset();
    cleanup();
  }
});
