// 045 T002a / FR-017a — the fixture harness, exercised by the two tasks that
// declared it a prerequisite (T018 preflight, T024 origin gate) plus the pack
// install path it exists to make testable.
//
// Until now those criteria were asserted against hand-rolled objects; this
// drives the REAL install path over a REAL item layout, so "a pack installs and
// uninstalls within one test run" is demonstrated rather than assumed.
//   npm run test:unit -- tests/specs/method-pack-fixture.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { existsSync } from "fs";
import { join } from "path";
import { useTestDataDir } from "../services/_test-env";
import {
  writeMethodPack, installPack, uninstallPack, upgradePack, methodPackDescriptor,
  writeOverlay, writeOrphanOverlay, overlayPath, clearOverlay,
} from "../../e2e/_fixtures/method-pack";
import { installMethodPack, uninstallMethodPack, MethodOriginRefusedError, recordOriginOptIn } from "../../src/lib/specs/method/install";
import { getMethod, __resetMethodsForTest } from "../../src/lib/specs/method/registry";
import { __resetPackAgentRootsForTest, agentRoots } from "../../src/lib/agent/subagents/roots";
import { listSubAgents } from "../../src/lib/agent/subagents/store";
import { preflightMethodChange } from "../../src/lib/specs/method/preflight";
import type { MethodDescriptor } from "../../src/lib/specs/method/types";

test("a fixture pack installs and uninstalls within a single test run", async () => {
  const { dir, cleanup } = useTestDataDir("fixture-pack-lifecycle");
  try {
    __resetMethodsForTest();
    __resetPackAgentRootsForTest();

    const pack = writeMethodPack(dir, { packId: "fx", agents: ["fx-driver"], skills: ["fx-skill"] });
    installPack(dir, "fx");
    // 035: install copies nothing — one symlink.
    expect(existsSync(join(dir, "system", "fx"))).toBe(true);

    await installMethodPack({ itemId: "fx", itemPath: pack.itemPath, facets: { plugin: false }, origin: "local" });

    expect(getMethod("fx")?.label).toBe("Fixture Method");
    expect(agentRoots().some((r) => r.packId === "fx"), "the pack contributes an agent root").toBe(true);
    expect((await listSubAgents()).map((a) => a.id), "its agent is DISCOVERED, not copied").toContain("fx-driver");
    expect(existsSync(join(dir, "agents", "fx-driver")), "and never copied into data/agents/").toBe(false);

    await uninstallMethodPack("fx");
    uninstallPack(dir, "fx");

    expect(getMethod("fx"), "descriptor unregistered").toBeUndefined();
    expect(agentRoots().some((r) => r.packId === "fx"), "agent root unregistered").toBe(false);
    expect(existsSync(pack.itemPath), "the item itself survives — uninstall removes the link, not the content").toBe(true);
  } finally {
    __resetPackAgentRootsForTest();
    cleanup();
  }
});

test("an installed pack's templates mount from <item>/method, not the item root", async () => {
  // The other half of the pack-root bug. `templates` is pack-relative, so it
  // resolves against `<item>/method` — resolving against the item root mounts
  // a directory that does not exist, and every prompt reading
  // /Methods/<id>/templates/... then fails with an empty read. Silent, and
  // indistinguishable from a prompt bug.
  const { dir, cleanup } = useTestDataDir("fixture-pack-templates");
  try {
    __resetMethodsForTest();
    __resetPackAgentRootsForTest();
    const pack = writeMethodPack(dir, { packId: "fx-tpl" });
    installPack(dir, "fx-tpl");
    await installMethodPack({ itemId: "fx-tpl", itemPath: pack.itemPath, facets: { plugin: false }, origin: "local" });

    const { methodPackRoot } = await import("../../src/lib/specs/method/registry");
    expect(methodPackRoot("fx-tpl")).toBe(join(pack.itemPath, "method"));

    const vfs = await import("../../src/os/vfs");
    expect(await vfs.readText("/Methods/fx-tpl/templates/spec-template.md")).toContain("Fixture spec template");
    expect(await vfs.readText("/Methods/fx-tpl/templates/commands/specify.md")).toContain("Fixture specify prompt");

    await uninstallMethodPack("fx-tpl");
    // FR-016: an uninstalled pack's templates must stop resolving, or the pack
    // reads as still installed.
    await expect(vfs.readText("/Methods/fx-tpl/templates/spec-template.md")).rejects.toThrow();
  } finally {
    __resetPackAgentRootsForTest();
    cleanup();
  }
});

test("T024/SC-016 — the origin gate refuses a plugin-bearing pack from a marketplace, until opted in", async () => {
  const { dir, cleanup } = useTestDataDir("fixture-pack-origin");
  try {
    __resetMethodsForTest();
    __resetPackAgentRootsForTest();
    // The SAME pack, offered from two origins — which is why the fixture is
    // parameterized rather than fixed.
    const pack = writeMethodPack(dir, { packId: "fx-plugin", withPlugin: true });
    installPack(dir, "fx-plugin");
    const input = { itemId: "fx-plugin", itemPath: pack.itemPath, facets: { plugin: true } };

    // From the user's own user-apps: installs freely.
    await expect(installMethodPack({ ...input, origin: "local" })).resolves.toBeDefined();
    __resetMethodsForTest();

    // From any other marketplace: refused until an explicit per-pack opt-in.
    await expect(installMethodPack({ ...input, origin: "marketplace" })).rejects.toThrow(MethodOriginRefusedError);
    expect(getMethod("fx-plugin"), "a refused pack must not be half-registered").toBeUndefined();

    await recordOriginOptIn("fx-plugin");
    await expect(installMethodPack({ ...input, origin: "marketplace" })).resolves.toBeDefined();
  } finally {
    __resetPackAgentRootsForTest();
    cleanup();
  }
});

test("T018/SC-010 — a pack UPGRADE that changes leafMarker is caught by preflight", async () => {
  // FR-010c's trigger, and the dangerous one: nobody chose this change. The
  // fixture's v2 differs only in `leafMarker`, which is exactly what makes
  // previously-discovered content stop being discovered.
  const { dir, cleanup } = useTestDataDir("fixture-pack-upgrade");
  try {
    const { ensureStores } = await import("../../src/lib/specs/seed");
    const { specsRoot } = await import("../../src/os/specs-dir");
    const { mkdirSync, writeFileSync } = await import("fs");
    const { execFileSync } = await import("child_process");
    await ensureStores();
    const us = join(specsRoot(), "user-specs");
    mkdirSync(join(us, "p", "001-a"), { recursive: true });
    writeFileSync(join(us, "p", "project.json"), JSON.stringify({ label: "P" }));
    writeFileSync(join(us, "p", "001-a", "spec.md"), "# A\n");
    execFileSync("git", ["add", "-A"], { cwd: us });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c"], { cwd: us });

    writeMethodPack(dir, { packId: "fx-up", leafMarker: "spec.md" });
    const v1 = methodPackDescriptor({ packId: "fx-up", leafMarker: "spec.md" }) as unknown as MethodDescriptor;
    upgradePack(dir, "fx-up", { packId: "fx-up", leafMarker: "proposal.md", version: "2.0.0" });
    const v2 = methodPackDescriptor({ packId: "fx-up", leafMarker: "proposal.md" }) as unknown as MethodDescriptor;

    const report = await preflightMethodChange("user-specs", v1, v2);
    expect(report.wouldOrphan, "the upgrade hides content and must be caught").toBe(true);
    expect(report.orphaned).toContain("p/001-a");
  } finally {
    cleanup();
  }
});

test("an unsupported schemaVersion is refused at install, naming both versions", async () => {
  const { dir, cleanup } = useTestDataDir("fixture-pack-schema");
  try {
    __resetMethodsForTest();
    const pack = writeMethodPack(dir, { packId: "fx-future", schemaVersion: 99 });
    installPack(dir, "fx-future");
    await expect(
      installMethodPack({ itemId: "fx-future", itemPath: pack.itemPath, facets: { plugin: false }, origin: "local" }),
    ).rejects.toThrow(/99.*supports 1|supports 1.*99/s);
    expect(getMethod("fx-future")).toBeUndefined();
  } finally {
    cleanup();
  }
});

// A pack that does not say where its specs go in a repository is refused at
// INSTALL, which is the only moment a marketplace pack's descriptor is read by
// code that can refuse it. This is the boundary the real defect crossed: `bmad`
// and `openspec` shipped without the field, installed cleanly, and the symptom
// appeared much later and silently — detectMethod skips such a pack, so a repo
// already laid out for that framework was never offered it.
test("a pack that does not declare storeRoot is refused at install, naming the pack", async () => {
  const { dir, cleanup } = useTestDataDir("fixture-pack-storeroot");
  try {
    __resetMethodsForTest();
    const pack = writeMethodPack(dir, { packId: "fx-noroot", storeRoot: "" });
    installPack(dir, "fx-noroot");
    await expect(
      installMethodPack({ itemId: "fx-noroot", itemPath: pack.itemPath, facets: { plugin: false }, origin: "local" }),
    ).rejects.toThrow(/"fx-noroot".*storeRoot/s);
    expect(getMethod("fx-noroot"), "a refused pack must not be half-registered").toBeUndefined();
  } finally {
    cleanup();
  }
});

test("048's BMAD-shaped layout: modules each contributing their own agents", () => {
  // 048 FR-006/FR-007 — modules with per-module visibility. Pinned here so the
  // harness is known to support that shape BEFORE 048 is designed against it.
  const { dir, cleanup } = useTestDataDir("fixture-pack-modules");
  try {
    const pack = writeMethodPack(dir, {
      packId: "fx-bmad",
      modules: [
        { id: "bmm", default: true, requiresConfig: true, agents: ["analyst", "pm"], visibility: "delegate-only" },
        { id: "cis", default: false, agents: ["brainstorm-coach"], visibility: "picker" },
      ],
    });
    for (const [mod, agent] of [["bmm", "analyst"], ["bmm", "pm"], ["cis", "brainstorm-coach"]]) {
      expect(existsSync(join(pack.itemPath, "method", "modules", mod, "agents", agent, "AGENT.md")), `${mod}/${agent}`).toBe(true);
    }
    // Full ModuleSpec objects since 048 T010 — bare ids would read as
    // `default: true` with no visibility, which is not the shape 048 needs.
    expect(pack.descriptor.modules).toEqual([
      { id: "bmm", default: true, requiresConfig: true, visibility: "delegate-only", agentsDir: "modules/bmm/agents" },
      { id: "cis", default: false, visibility: "picker", agentsDir: "modules/cis/agents" },
    ]);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 048 T001 — the writable-overlay fixture.
//
// Layout only. SHADOWING is asserted at 048 T007, when precedence actually
// gains the overlay level — asserting it here would be testing a mechanism
// that does not exist yet, and would pass for the wrong reason (the overlay
// agent simply not being found at all).
// ---------------------------------------------------------------------------

test("T001 — the overlay fixture writes where the product will read", () => {
  const { dir, cleanup } = useTestDataDir("overlay-fixture-layout");
  try {
    const root = writeOverlay(dir, "fx", { agents: ["custom"], modules: { bmm: ["analyst"] } });

    // data/method-packs/<packId>/ — deliberately NOT inside the item, which the
    // marketplace overwrites on upgrade (US3).
    expect(root).toBe(overlayPath(dir, "fx"));
    expect(root).toBe(join(dir, "method-packs", "fx"));
    expect(existsSync(join(root, "agents", "custom", "AGENT.md"))).toBe(true);
    expect(existsSync(join(root, "modules", "bmm", "agents", "analyst", "AGENT.md"))).toBe(true);

    // The overlay mirrors the PACK's layout, so one precedence rule can walk
    // both without a special case (FR-002a).
    const pack = writeMethodPack(dir, { packId: "fx", modules: [{ id: "bmm", agents: ["analyst"] }] });
    expect(existsSync(join(pack.itemPath, "method", "modules", "bmm", "agents", "analyst", "AGENT.md"))).toBe(true);

    clearOverlay(dir, "fx");
    expect(existsSync(root), "clearing reverts customisations without touching the pack").toBe(false);
    expect(existsSync(join(pack.itemPath, "method", "method.json")), "the pack is untouched").toBe(true);
  } finally {
    cleanup();
  }
});

test("T001 — an orphan overlay creates NOTHING else (FR-004a's precondition)", () => {
  // The inertness RULE is T006's. This pins the fixture's half: writing an
  // orphan overlay must not quietly produce an item, a manifest entry or an
  // install link, or T006's test would pass because the pack was installed
  // rather than because the overlay was inert.
  const { dir, cleanup } = useTestDataDir("overlay-fixture-orphan");
  try {
    writeOrphanOverlay(dir, "never-installed", { agents: ["ghost"] });

    expect(existsSync(overlayPath(dir, "never-installed"))).toBe(true);
    expect(existsSync(join(dir, "user-apps", "items", "never-installed")), "no item").toBe(false);
    expect(existsSync(join(dir, "system", "never-installed")), "no install link").toBe(false);
    expect(existsSync(join(dir, "user-apps", "marketplace.json")), "no manifest entry").toBe(false);
  } finally {
    cleanup();
  }
});

test("an INSTALLED pack re-registers at boot, not only at install", async () => {
  // The bug this pins was found by restarting a real BOS: installMethodPack ran
  // on the install ACTION and nothing re-ran it on startup, so a pack's
  // descriptor, agent roots, template mount and overlay lived only in the
  // memory of the process that installed it. The pack worked until the first
  // restart and then silently vanished — while its item symlink, its overlay
  // and its marketplace entry all still said it was installed.
  //
  // Services and bos-plugins each already had a boot pass. Methods did not.
  const { registerInstalledMethodPacks } = await import("../../src/lib/specs/method/install");
  const { dir, cleanup } = useTestDataDir("fixture-pack-boot");
  try {
    __resetMethodsForTest();
    __resetPackAgentRootsForTest();
    const pack = writeMethodPack(dir, { packId: "fx-boot", agents: ["fx-agent"] });
    installPack(dir, "fx-boot");
    await installMethodPack({ itemId: "fx-boot", itemPath: pack.itemPath, facets: { plugin: false }, origin: "local" });
    expect(getMethod("fx-boot")).toBeDefined();

    // Simulate the restart: every in-memory registration is gone, but the
    // INSTALL STATE on disk (the symlink, the item) is untouched.
    __resetMethodsForTest();
    __resetPackAgentRootsForTest();
    expect(getMethod("fx-boot"), "nothing survives a process restart in memory").toBeUndefined();

    const registered = await registerInstalledMethodPacks();

    expect(registered, "the boot pass finds it from the install state").toContain("fx-boot");
    expect(getMethod("fx-boot")?.label).toBe("Fixture Method");
    expect((await listSubAgents()).map((a) => a.id), "and its agents resolve again").toContain("fx-agent");
  } finally {
    __resetPackAgentRootsForTest();
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// A declared path the pack does not ship
// ---------------------------------------------------------------------------

test("a templates directory a pack DECLARES but does not ship is reported", async () => {
  // BMAD shipped in exactly this state for as long as it existed: `method.json`
  // said `"templates": "templates"` and no such directory was ever committed,
  // while its own driver skill told five phases to author against the mount.
  //
  // Git made it invisible — an EMPTY DIRECTORY CANNOT BE COMMITTED, so there was
  // no missing file and no deletion in the log to notice. `git ls-files` over
  // that path returned nothing, and it had no history at all. Only a check
  // against the installed tree can catch it, which is what this pins.
  const { cleanup } = useTestDataDir("fixture-pack-missing-templates");
  try {
    const { missingTemplatesDir } = await import("../../src/lib/specs/method/install");
    const base = { schemaVersion: 1, id: "t", label: "T", version: "1", phases: [], sections: [],
      artifacts: [], artifactOrder: [], constitution: "c", constitutionRoot: "system" as const,
      discrepancies: { rel: "d", roots: ["system" as const] },
      stateLabels: { done: "", pending: "", blocked: "", na: "" }, storeRoot: ".",
      agents: [], roles: {} };
    const root = process.cwd();

    expect(
      await missingTemplatesDir({ ...base, templates: "no-such-dir" } as MethodDescriptor, root),
      "declared and absent — the BMAD case",
    ).toBe(join(root, "no-such-dir"));

    expect(
      await missingTemplatesDir({ ...base } as MethodDescriptor, root),
      "declares NONE, which is a different state and not a mistake",
    ).toBeUndefined();

    expect(
      await missingTemplatesDir({ ...base, templates: "src" } as MethodDescriptor, root),
      "declared and shipped",
    ).toBeUndefined();

    expect(
      await missingTemplatesDir({ ...base, templates: "package.json" } as MethodDescriptor, root),
      "a FILE where a directory was declared is just as wrong",
    ).toBe(join(root, "package.json"));
  } finally {
    cleanup();
  }
});

test("BMAD's own descriptor no longer declares templates it does not have", async () => {
  // The pack fix, pinned. If someone re-adds the declaration without adding the
  // directory, this fails rather than the mount silently breaking again.
  const { cleanup } = useTestDataDir("fixture-pack-bmad-templates");
  try {
    const bmad = join(process.cwd(), "data/user-apps/items/bmad/method");
    test.skip(!existsSync(bmad), "BMAD is not installed");
    const { missingTemplatesDir } = await import("../../src/lib/specs/method/install");
    const { readFileSync } = await import("fs");
    const d = JSON.parse(readFileSync(join(bmad, "method.json"), "utf8")) as MethodDescriptor;
    expect(await missingTemplatesDir(d, bmad), "declares none, or ships what it declares").toBeUndefined();
  } finally {
    cleanup();
  }
});
