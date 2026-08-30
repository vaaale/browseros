// Unit tests for createItemSpec() (src/lib/specs/create.ts) — the decision
// point that routes a marketplace item's spec into the item itself (via the
// same installItem() chokepoint app/service code goes through) instead of
// the centralized user-specs store. Covers: a brand-new item comes into
// existence with just a spec, id collisions de-dupe, an existing spec is
// never silently overwritten, and the new item is immediately visible
// through the same discovery chain item-stores.test.ts already covers.
//   npm run test:unit -- tests/specs/create-item-spec.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { existsSync, readFileSync, mkdirSync, writeFileSync, symlinkSync } from "fs";
import { execFileSync } from "child_process";
import { useTestDataDir } from "../services/_test-env";
import { createItemSpec } from "../../src/lib/specs/create";
import { listStores } from "../../src/lib/specs/stores";
import { specTree } from "../../src/lib/specs/pipeline";

// createItemSpec is branch-gated like every other spec write (038-user-apps-
// branch-coupling): an item's spec lives in user-apps, a branch-coupled repo.
const BRANCH = "bos/test-feature";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("creates a brand-new item from just a spec — symlinked, committed, no code required", async () => {
  const { dir, cleanup } = useTestDataDir("create-item-spec-new");
  try {
    const { id, path } = await createItemSpec({ name: "My Widget", specBody: "# My Widget\n\nDoes widget things.\n", branch: BRANCH });
    expect(id).toBe("my-widget");
    expect(path).toBe("item-my-widget/spec.md");

    const itemPath = join(dir, "user-apps", "items", "my-widget");
    expect(existsSync(join(itemPath, "spec", "spec.md"))).toBe(true);
    expect(readFileSync(join(itemPath, "spec", "spec.md"), "utf8")).toContain("Does widget things.");
    expect(existsSync(join(dir, "system", "my-widget"))).toBe(true); // installed (035)

    const log = git(join(dir, "user-apps"), ["log", "--oneline"]);
    expect(log).toContain("install item my-widget");
  } finally {
    cleanup();
  }
});

test("de-dupes a colliding auto-generated id", async () => {
  const { cleanup } = useTestDataDir("create-item-spec-dedupe");
  try {
    const first = await createItemSpec({ name: "Notes", specBody: "# Notes\n", branch: BRANCH });
    const second = await createItemSpec({ name: "Notes", specBody: "# Notes (2)\n", branch: BRANCH });
    expect(first.id).toBe("notes");
    expect(second.id).toBe("notes-2");
  } finally {
    cleanup();
  }
});

test("refuses to overwrite an item that already has a spec", async () => {
  const { cleanup } = useTestDataDir("create-item-spec-refuse");
  try {
    await createItemSpec({ name: "Gadget", id: "gadget", specBody: "# Gadget v1\n", branch: BRANCH });
    await expect(createItemSpec({ name: "Gadget", id: "gadget", specBody: "# Gadget v2\n", branch: BRANCH })).rejects.toThrow(/already has a spec/i);
  } finally {
    cleanup();
  }
});

test("a newly created item spec is immediately visible via listStores/specTree", async () => {
  const { cleanup } = useTestDataDir("create-item-spec-visible");
  try {
    await createItemSpec({ name: "Sprocket", specBody: "# Sprocket\n", branch: BRANCH });

    const stores = await listStores();
    const store = stores.find((s) => s.id === "item-sprocket");
    expect(store).toBeTruthy();
    expect(store?.owner).toBe("item");
    expect(store?.writable).toBe(true);

    const tree = await specTree();
    expect(tree.find((g) => g.path === "item-sprocket")).toBeTruthy();
  } finally {
    cleanup();
  }
});

test("rejects an id that would traverse outside user-apps/items/", async () => {
  const { dir, cleanup } = useTestDataDir("create-item-spec-traversal");
  try {
    await expect(createItemSpec({ name: "Evil", id: "../../../../tmp/pwned", specBody: "# x\n", branch: BRANCH })).rejects.toThrow(/invalid item id/i);
    await expect(createItemSpec({ name: "Evil", id: "..", specBody: "# x\n", branch: BRANCH })).rejects.toThrow(/invalid item id/i);
    // Nothing must have been written outside the sandboxed test dataDir.
    expect(existsSync(join(dir, "..", "pwned"))).toBe(false);
  } finally {
    cleanup();
  }
});

test("refuses a reserved item id before writing or committing anything", async () => {
  const { dir, cleanup } = useTestDataDir("create-item-spec-reserved");
  try {
    await expect(createItemSpec({ name: "Config", id: "config", specBody: "# x\n", branch: BRANCH })).rejects.toThrow(/reserved item id/i);
    expect(existsSync(join(dir, "user-apps", "items", "config"))).toBe(false);
  } finally {
    cleanup();
  }
});

test("refuses an id already installed from a marketplace, without writing a shadow copy", async () => {
  const { dir, cleanup } = useTestDataDir("create-item-spec-marketplace-collision");
  try {
    // Lay out a marketplace-sourced item (no spec facet yet) and install it via symlink.
    const marketplaceItemPath = join(dir, "marketplace", "acme", "items", "gadget");
    mkdirSync(join(marketplaceItemPath, "app"), { recursive: true });
    writeFileSync(join(marketplaceItemPath, "app", "index.html"), "<!doctype html>");
    mkdirSync(join(dir, "system"), { recursive: true });
    symlinkSync(marketplaceItemPath, join(dir, "system", "gadget"));

    await expect(createItemSpec({ name: "Gadget", id: "gadget", specBody: "# Gadget\n", branch: BRANCH })).rejects.toThrow(/already installed from a marketplace/i);
    // No shadow directory should have been created under the user's own user-apps.
    expect(existsSync(join(dir, "user-apps", "items", "gadget"))).toBe(false);
  } finally {
    cleanup();
  }
});

test("concurrent creates for the same name never clobber — both succeed with distinct ids", async () => {
  const { dir, cleanup } = useTestDataDir("create-item-spec-concurrent");
  try {
    const [a, b] = await Promise.all([
      createItemSpec({ name: "Race", specBody: "# Race A\n", branch: BRANCH }),
      createItemSpec({ name: "Race", specBody: "# Race B\n", branch: BRANCH }),
    ]);
    expect(a.id).not.toBe(b.id);
    expect([a.id, b.id].sort()).toEqual(["race", "race-2"]);
    const bodyFor = (id: string) => readFileSync(join(dir, "user-apps", "items", id, "spec", "spec.md"), "utf8");
    expect(bodyFor(a.id)).toContain(a.id === "race" ? "Race A" : "Race B");
    expect(bodyFor(b.id)).toContain(b.id === "race" ? "Race A" : "Race B");
  } finally {
    cleanup();
  }
});

test("concurrent creates for the SAME explicit id: exactly one succeeds, the other gets a clean refusal", async () => {
  const { dir, cleanup } = useTestDataDir("create-item-spec-concurrent-explicit-id");
  try {
    const results = await Promise.allSettled([
      createItemSpec({ name: "Shared", id: "shared", specBody: "# Shared A\n", branch: BRANCH }),
      createItemSpec({ name: "Shared", id: "shared", specBody: "# Shared B\n", branch: BRANCH }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already has a spec/i);
    // Whichever call won, its content is intact and not partially overwritten.
    const body = readFileSync(join(dir, "user-apps", "items", "shared", "spec", "spec.md"), "utf8");
    expect(body === "# Shared A\n" || body === "# Shared B\n").toBe(true);
  } finally {
    cleanup();
  }
});

test("createItemSpec is refused with no active feature branch, writing nothing", async () => {
  const { dir, cleanup } = useTestDataDir("create-item-spec-branch-gate");
  try {
    await expect(
      createItemSpec({ name: "Ungated", specBody: "# Ungated\n" }),
    ).rejects.toThrow(/needs an active feature branch/i);
    // The gate must run BEFORE any write or commit — app_spec_create reaches
    // user-apps through installItem(), not spec-fs, so spec-fs's own
    // prepareWrite gate never sees it. This was the one hole left in the rule.
    expect(existsSync(join(dir, "user-apps", "items", "ungated"))).toBe(false);
  } finally {
    cleanup();
  }
});
