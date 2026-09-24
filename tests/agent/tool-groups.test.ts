// Tool-group model (041-tool-groups): the built-in table, the dynamic
// (service-declared) layer, resolveGroup's fixed precedence, the persisted
// override store, and the two invariants the rest of the feature leans on —
// every Capability.group resolves to a live group (ADR-1/R3), and NOTHING
// anywhere produces a fallback group (FR-041).
//   npx playwright test -c playwright.unit.config.ts tests/agent/tool-groups.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { useTestDataDir } from "../services/_test-env";
import {
  BUILTIN_TOOL_GROUPS,
  listToolGroups,
  groupById,
  registerToolGroups,
  resolveGroup,
  unregisterToolGroups,
  type ToolGroup,
} from "../../src/lib/agent/tool-groups";
import { listCapabilities, registerAdditionalCapabilities, unregisterCapabilities } from "../../src/lib/agent/capabilities-registry";
import {
  getEffectiveGroup,
  readGroupOverrides,
  setGroupOverride,
} from "../../src/lib/agent/tool-group-overrides";

const DYNAMIC_IDS = ["workflows", "zzz-late", "aaa-early", "kb"];
test.afterEach(() => unregisterToolGroups(DYNAMIC_IDS));

function group(id: string, over: Partial<ToolGroup> = {}): ToolGroup {
  return {
    id,
    name: over.name ?? id,
    description: over.description ?? `The ${id} group.`,
    aliases: over.aliases ?? [],
    origin: "service",
  };
}

// ── Built-in table ──────────────────────────────────────────────────────────

test("every built-in group has a slug id, a name and a real description", () => {
  for (const g of BUILTIN_TOOL_GROUPS) {
    expect(g.id, `${g.name} id must be a lowercase slug`).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(g.name.trim().length).toBeGreaterThan(0);
    // A real sentence, not a synthesized placeholder. The old
    // groupDescription() fallback ("Capabilities in the \"X\" group.") is
    // exactly what FR-041 deletes, so no group may look like one.
    expect(g.description.trim().length).toBeGreaterThan(30);
    expect(g.description).not.toMatch(/^Capabilities in the /);
  }
});

test("built-in group ids are unique", () => {
  const ids = BUILTIN_TOOL_GROUPS.map((g) => g.id);
  expect(new Set(ids).size).toBe(ids.length);
});

// ── ADR-1 / R3: the migration invariant ─────────────────────────────────────

test("every capability's group id resolves to a live group", () => {
  // Also the detector for a LEAKED FIXTURE, and that is how it earns its keep.
  // `listCapabilities()` includes dynamically registered ones, which live on
  // globalThis and outlive the test file that added them — every unit-test file
  // shares a worker process. A fixture that unregisters its group but not its
  // capabilities leaves exactly this: an id pointing at nothing.
  //
  // It caught service-tool-bridge.test.ts doing that, whose afterEach removed a
  // HAND-KEPT list of names that had drifted from the ones its tests registered.
  // If this fails naming a tool you do not recognise, look for the fixture that
  // registered it rather than for a real capability defect.
  const unresolved = listCapabilities()
    .filter((c) => groupById(c.group) === undefined)
    .map((c) => `${c.id} -> ${c.group}`);
  expect(unresolved, "capabilities pointing at a non-existent group — usually a fixture that did not clean up").toEqual([]);
});

test("groupById returns undefined for an unknown id — it never invents a group", () => {
  expect(groupById("no-such-group")).toBeUndefined();
  expect(groupById("")).toBeUndefined();
  // FR-041: no bucket named General/Other/Service Tools exists to fall into.
  const names = listToolGroups().map((g) => g.name.toLowerCase());
  expect(names).not.toContain("general");
  expect(names).not.toContain("other");
  expect(names).not.toContain("service tools");
});

// ── Dynamic layer (FR-003 / FR-004) ─────────────────────────────────────────

test("registered service groups appear; unregistering removes them", () => {
  expect(groupById("workflows")).toBeUndefined();
  registerToolGroups([group("workflows", { name: "Workflows" })]);
  expect(groupById("workflows")?.name).toBe("Workflows");
  unregisterToolGroups(["workflows"]);
  expect(groupById("workflows")).toBeUndefined();
});

test("re-registering the same id updates in place rather than duplicating", () => {
  registerToolGroups([group("workflows", { description: "First description of the workflows group." })]);
  registerToolGroups([group("workflows", { description: "Second description of the workflows group." })]);
  const matches = listToolGroups().filter((g) => g.id === "workflows");
  expect(matches).toHaveLength(1);
  expect(matches[0].description).toContain("Second");
});

test("ordering is built-ins in table order, then dynamic groups by id (FR-012)", () => {
  registerToolGroups([group("zzz-late"), group("aaa-early")]);
  const ids = listToolGroups().map((g) => g.id);
  const builtinIds = BUILTIN_TOOL_GROUPS.map((g) => g.id);
  expect(ids.slice(0, builtinIds.length)).toEqual(builtinIds);
  expect(ids.slice(builtinIds.length)).toEqual(["aaa-early", "zzz-late"]);
});

// ── resolveGroup precedence (FR-030) ────────────────────────────────────────

test("resolveGroup matches id, display name and alias, case/space-insensitively", () => {
  expect(resolveGroup("web")?.id).toBe("web");
  expect(resolveGroup("WEB")?.id).toBe("web");
  expect(resolveGroup("  Google Drive  ")?.id).toBe("google-drive");
  expect(resolveGroup("google drive")?.id).toBe("google-drive");
  expect(resolveGroup("google_drive")?.id).toBe("google-drive");
  expect(resolveGroup("GOOGLE-DRIVE")?.id).toBe("google-drive");
  // alias tier
  expect(resolveGroup("email")?.id).toBe("gmail");
  expect(resolveGroup("cron")?.id).toBe("scheduler");
});

test("an alias colliding with another group's id loses to the id, deterministically", () => {
  // A service group whose ALIAS is "web" must never shadow the built-in group
  // whose ID is "web": the id tier is checked first and wins outright.
  registerToolGroups([group("kb", { aliases: ["web"] })]);
  expect(resolveGroup("web")?.id).toBe("web");
  // And the colliding group is still reachable by its own id.
  expect(resolveGroup("kb")?.id).toBe("kb");
});

test("resolveGroup returns undefined rather than guessing", () => {
  expect(resolveGroup("definitely not a group")).toBeUndefined();
  expect(resolveGroup("")).toBeUndefined();
  expect(resolveGroup("   ")).toBeUndefined();
});

// ── Override store (FR-046 / FR-049) ────────────────────────────────────────

test("an override round-trips and reports the source values for reset", async () => {
  const env = useTestDataDir("tool-group-overrides");
  try {
    await setGroupOverride("web", { description: "Only our intranet, nothing external." });
    const eff = await getEffectiveGroup("web");
    expect(eff?.description).toBe("Only our intranet, nothing external.");
    expect(eff?.sourceDescription).toContain("Web operations");
    expect(eff?.overridden).toBe(true);
  } finally {
    env.cleanup();
  }
});

test("an override written for a service group SURVIVES that group leaving the catalog (FR-049)", async () => {
  const env = useTestDataDir("tool-group-overrides-absent");
  try {
    registerToolGroups([group("workflows", { name: "Workflows" })]);
    await setGroupOverride("workflows", { description: "Our own workflow engine." });

    // Service stops → group leaves the live catalog.
    unregisterToolGroups(["workflows"]);
    expect(await getEffectiveGroup("workflows")).toBeUndefined();

    // ...but the user's curation is still on disk, and comes back with it.
    expect((await readGroupOverrides()).workflows?.description).toBe("Our own workflow engine.");
    registerToolGroups([group("workflows", { name: "Workflows" })]);
    expect((await getEffectiveGroup("workflows"))?.description).toBe("Our own workflow engine.");
  } finally {
    env.cleanup();
  }
});

test("a value equal to the built-in default is not stored as an override", async () => {
  const env = useTestDataDir("tool-group-overrides-noop");
  try {
    const web = groupById("web")!;
    await setGroupOverride("web", { description: web.description });
    expect(await readGroupOverrides()).toEqual({});
  } finally {
    env.cleanup();
  }
});

test("clearing an override restores the source description", async () => {
  const env = useTestDataDir("tool-group-overrides-clear");
  try {
    await setGroupOverride("web", { description: "Custom." });
    await setGroupOverride("web", { description: "" });
    const eff = await getEffectiveGroup("web");
    expect(eff?.overridden).toBe(false);
    expect(eff?.description).toBe(eff?.sourceDescription);
  } finally {
    env.cleanup();
  }
});

test("a malformed group id is rejected instead of silently written", async () => {
  const env = useTestDataDir("tool-group-overrides-bad-id");
  try {
    await expect(setGroupOverride("Not A Slug", { description: "x" })).rejects.toThrow(/invalid group id/);
  } finally {
    env.cleanup();
  }
});

// ── Dynamically-registered capabilities keep resolving ──────────────────────

test("a service capability registered under a declared group resolves", () => {
  try {
    registerToolGroups([group("workflows", { name: "Workflows" })]);
    registerAdditionalCapabilities([
      { id: "workflow_list", group: "workflows", context: "tool", description: "List workflows." },
    ]);
    const cap = listCapabilities().find((c) => c.id === "workflow_list");
    expect(cap?.group).toBe("workflows");
    expect(groupById(cap!.group)?.name).toBe("Workflows");
  } finally {
    unregisterCapabilities(["workflow_list"]);
  }
});
