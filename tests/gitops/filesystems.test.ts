// Unit tests for src/lib/gitops/filesystems.ts's getAvailableGitFsInstances() —
// specifically the hasGitDir() guard on the spec-store loop. Before this guard
// existed, every listStores() result (including an item-owned store, rooted at
// a bare subdirectory of the shared user-apps repo with no .git of its own) was
// pushed unconditionally as a pushable/pullable "GitFS instance" in Settings ->
// Versions — a remote add/push/pull against it would silently act on the WHOLE
// user-apps repo instead of the one item it claimed to be scoped to.
//   npm run test:unit -- tests/gitops/filesystems.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, symlinkSync } from "fs";
import { execFileSync } from "child_process";
import { useTestDataDir } from "../services/_test-env";
import { getAvailableGitFsInstances } from "../../src/lib/gitops/filesystems";

test("an item-owned spec store never appears as a GitFS instance (it owns no .git of its own)", async () => {
  const { dir, cleanup } = useTestDataDir("filesystems-item-store-excluded");
  try {
    // A real, directory-scanned store (owns its own .git) — must still appear.
    const userSpecsDir = join(dir, "specs", "user-specs");
    mkdirSync(userSpecsDir, { recursive: true });
    writeFileSync(join(userSpecsDir, "spec-store.json"), JSON.stringify({ label: "User specs", owner: "user", writable: true, requiresPromote: false }));
    execFileSync("git", ["init", "-q"], { cwd: userSpecsDir });

    // An item-owned store — rooted at <itemPath>/spec, a bare subdirectory of
    // the shared user-apps repo, with no .git of its own.
    const itemPath = join(dir, "user-apps", "items", "widget");
    mkdirSync(join(itemPath, "spec"), { recursive: true });
    writeFileSync(join(itemPath, "spec", "spec.md"), "# Widget\n");
    mkdirSync(join(dir, "system"), { recursive: true });
    symlinkSync(itemPath, join(dir, "system", "widget"));

    const instances = await getAvailableGitFsInstances();
    expect(instances.find((i) => i.id === "user-specs")).toBeTruthy();
    expect(instances.find((i) => i.id === "item-widget")).toBeUndefined();
  } finally {
    cleanup();
  }
});
