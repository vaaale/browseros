// 048 Phase 2 — the pack overlay (FR-004, FR-004a, FR-005, US3, SC-005, SC-010).
//
// The overlay is where BMB writes. It must outrank the pack it customises,
// survive that pack being upgraded, and — crucially — must NOT be able to bring
// content into existence on its own, which would make it a second install path.
//   npm run test:unit -- tests/specs/method-overlay.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { useTestDataDir } from "../services/_test-env";
import {
  writeMethodPack, installPack, writeOverlay, writeOrphanOverlay, overlayPath, clearOverlay, upgradePack,
} from "../../e2e/_fixtures/method-pack";
import { installMethodPack, uninstallMethodPack } from "../../src/lib/specs/method/install";
import { __resetMethodsForTest } from "../../src/lib/specs/method/registry";
import { __resetPackAgentRootsForTest } from "../../src/lib/agent/subagents/roots";
import { listSubAgents } from "../../src/lib/agent/subagents/store";
import { orphanOverlays, packOverlayDir } from "../../src/lib/specs/method/overlay";

function reset(): void {
  __resetMethodsForTest();
  __resetPackAgentRootsForTest();
}

/** Install a pack whose root ships `agentId`. */
async function installWithAgent(dir: string, packId: string, agentId: string) {
  const pack = writeMethodPack(dir, { packId, agents: [agentId] });
  installPack(dir, packId);
  await installMethodPack({ itemId: packId, itemPath: pack.itemPath, facets: { plugin: false }, origin: "local" });
  return pack;
}

test("US3 — an overlay agent SHADOWS the pack's own copy of the same id", async () => {
  const { dir, cleanup } = useTestDataDir("overlay-shadows");
  try {
    reset();
    await installWithAgent(dir, "fx", "architect");
    expect((await listSubAgents()).find((a) => a.id === "architect")?.sourceRoot).toBe("Fixture Method");

    // BMB customises it.
    writeOverlay(dir, "fx", { agents: ["architect"], body: () => "---\nname: My Architect\ntype: local\n---\n\nCustomised.\n" });

    const architect = (await listSubAgents()).find((a) => a.id === "architect");
    expect(architect?.name, "the overlay outranks the pack it customises").toBe("My Architect");
    expect(architect?.sourceRoot).toBe("Fixture Method (customised)");
  } finally {
    reset();
    cleanup();
  }
});

test("data/agents/ still outranks the overlay — a hand-written BOS agent is the final word", async () => {
  const { dir, cleanup } = useTestDataDir("overlay-vs-local");
  try {
    reset();
    await installWithAgent(dir, "fx", "architect");
    writeOverlay(dir, "fx", { agents: ["architect"], body: () => "---\nname: Overlay\ntype: local\n---\n\nx\n" });

    const { mkdirSync, writeFileSync } = await import("fs");
    mkdirSync(join(dir, "agents", "architect"), { recursive: true });
    writeFileSync(join(dir, "agents", "architect", "AGENT.md"), "---\nname: Local\ntype: local\n---\n\nx\n");

    expect((await listSubAgents()).find((a) => a.id === "architect")?.name).toBe("Local");
  } finally {
    reset();
    cleanup();
  }
});

test("SC-005 — a pack-root UPGRADE leaves overlay content untouched and still winning", async () => {
  // BMAD's stated intent is that its cast gets customised; a pack whose
  // customisations are lost on upgrade is unusable for its intended purpose.
  const { dir, cleanup } = useTestDataDir("overlay-survives-upgrade");
  try {
    reset();
    await installWithAgent(dir, "fx", "architect");
    writeOverlay(dir, "fx", { agents: ["architect"], body: () => "---\nname: Mine\ntype: local\n---\n\nMy careful edits.\n" });

    upgradePack(dir, "fx", { packId: "fx", version: "2.0.0" });

    const body = readFileSync(join(overlayPath(dir, "fx"), "agents", "architect", "AGENT.md"), "utf8");
    expect(body, "the overlay is untouched by the upgrade").toContain("My careful edits.");
    expect((await listSubAgents()).find((a) => a.id === "architect")?.name, "and still wins").toBe("Mine");
  } finally {
    reset();
    cleanup();
  }
});

test("SC-010 / FR-004a — an overlay whose pack is NOT installed brings nothing into existence", async () => {
  // If the overlay could contribute agents on its own, it would BE a second
  // install path: BOS would discover packs that were never installed, and 035's
  // one-mechanism rule would be broken. It is inert, and REPORTED.
  const { dir, cleanup } = useTestDataDir("overlay-orphan");
  try {
    reset();
    writeOrphanOverlay(dir, "never-installed", { agents: ["ghost"] });

    expect((await listSubAgents()).map((a) => a.id), "an orphan overlay contributes NOTHING").not.toContain("ghost");
    // …and it is reported rather than silently ignored, so a user can see why
    // their customisations stopped applying.
    expect(await orphanOverlays(new Set())).toEqual(["never-installed"]);
    // An INSTALLED pack's overlay is not an orphan.
    expect(await orphanOverlays(new Set(["never-installed"]))).toEqual([]);
  } finally {
    reset();
    cleanup();
  }
});

test("FR-005 — the overlay is writable through the VFS; the pack root is not", async () => {
  const { dir, cleanup } = useTestDataDir("overlay-mount");
  try {
    reset();
    const pack = await installWithAgent(dir, "fx", "architect");
    const vfs = await import("../../src/os/vfs");

    await vfs.writeText("/Methods/fx/overlay/agents/new-agent/AGENT.md", "---\nname: New\ntype: local\n---\n\nx\n");
    expect(existsSync(join(packOverlayDir("fx", dir), "agents", "new-agent", "AGENT.md")),
      "a write through the mount lands in the overlay").toBe(true);
    expect(existsSync(join(pack.itemPath, "method", "agents", "new-agent")),
      "and NEVER in the read-only pack root").toBe(false);

    // FR-016: an uninstalled pack's surfaces must stop resolving, or the pack
    // reads as still installed.
    await uninstallMethodPack("fx");
    await expect(vfs.readText("/Methods/fx/overlay/agents/new-agent/AGENT.md")).rejects.toThrow();
    // But the CONTENT survives — reinstalling restores the user's work rather
    // than silently discarding it.
    expect(existsSync(join(packOverlayDir("fx", dir), "agents", "new-agent", "AGENT.md"))).toBe(true);
  } finally {
    reset();
    cleanup();
  }
});

test("clearing an overlay reverts to the pack's own copy", async () => {
  const { dir, cleanup } = useTestDataDir("overlay-clear");
  try {
    reset();
    await installWithAgent(dir, "fx", "architect");
    writeOverlay(dir, "fx", { agents: ["architect"], body: () => "---\nname: Mine\ntype: local\n---\n\nx\n" });
    expect((await listSubAgents()).find((a) => a.id === "architect")?.name).toBe("Mine");

    clearOverlay(dir, "fx");
    expect((await listSubAgents()).find((a) => a.id === "architect")?.sourceRoot).toBe("Fixture Method");
  } finally {
    reset();
    cleanup();
  }
});
