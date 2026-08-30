// Unit tests for installItem()'s own preflight guards (src/lib/apps/store.ts) —
// the ROOT chokepoint every install path goes through: app_install, app_build,
// a marketplace install, and createItemSpec() (src/lib/specs/create.ts). A
// prior version only guarded the reserved-id/marketplace-collision cases
// inside createItemSpec()'s own preflight, leaving installItem()'s two OTHER,
// far more commonly used callers (POST /api/apps, POST /api/apps/build)
// exposed to the exact same bug: install writes files and commits them to the
// user's own git repo BEFORE createAppSymlink()/installItemLink() catches a
// reserved or cross-origin-colliding id, leaving a permanently orphaned,
// git-committed directory behind (purgeApp() itself refuses to remove it,
// since it looks marketplace-owned). These tests exercise installItem()
// directly, with no id supplied — i.e. exactly how /api/apps and
// /api/apps/build actually call it — to prove the guard is at the root, not
// just in one caller.
//   npm run test:unit -- tests/apps/install-item.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { existsSync, mkdirSync, symlinkSync } from "fs";
import { useTestDataDir } from "../services/_test-env";
import { installItem } from "../../src/lib/apps/store";

test("refuses a reserved item id (no explicit id — slugified from name) before writing or committing", async () => {
  const { dir, cleanup } = useTestDataDir("install-item-reserved");
  try {
    await expect(installItem({ name: "Config", files: { "app/index.html": "<!doctype html>" } })).rejects.toThrow(/reserved item id/i);
    expect(existsSync(join(dir, "user-apps", "items", "config"))).toBe(false);
  } finally {
    cleanup();
  }
});

test("refuses an id already installed from a different source, without writing a shadow copy", async () => {
  const { dir, cleanup } = useTestDataDir("install-item-collision");
  try {
    // Simulate an item already installed from a marketplace clone (a
    // different physical location than where a new local install would write).
    const marketplaceItemPath = join(dir, "marketplace", "acme", "items", "gadget");
    mkdirSync(join(marketplaceItemPath, "app"), { recursive: true });
    mkdirSync(join(dir, "system"), { recursive: true });
    symlinkSync(marketplaceItemPath, join(dir, "system", "gadget"));

    await expect(installItem({ name: "Gadget", files: { "app/index.html": "<!doctype html>" } })).rejects.toThrow(
      /already installed from a different source/i,
    );
    expect(existsSync(join(dir, "user-apps", "items", "gadget"))).toBe(false);
  } finally {
    cleanup();
  }
});

test("rejects a path-traversal id before any write", async () => {
  const { dir, cleanup } = useTestDataDir("install-item-traversal");
  try {
    await expect(installItem({ name: "Evil", id: "../../../tmp/pwned", files: { "app/index.html": "x" } })).rejects.toThrow(/invalid item id/i);
    expect(existsSync(join(dir, "..", "pwned"))).toBe(false);
  } finally {
    cleanup();
  }
});

test("re-installing the SAME already-installed local item is still allowed (not a false-positive collision)", async () => {
  const { dir, cleanup } = useTestDataDir("install-item-same-source-ok");
  try {
    const first = await installItem({ name: "Widget", id: "widget", files: { "app/index.html": "<p>v1</p>" } });
    expect(first.app).toBeTruthy();
    // A second install call for the SAME id resolves to the SAME itemDir
    // (user-apps/items/widget/) the existing symlink already points at —
    // must not be treated as a cross-origin collision.
    const second = await installItem({ name: "Widget", id: "widget", files: { "app/index.html": "<p>v2</p>" } });
    expect(second.app).toBeTruthy();
    expect(existsSync(join(dir, "user-apps", "items", "widget", "app", "index.html"))).toBe(true);
  } finally {
    cleanup();
  }
});

test("a service.json id that does not match the item id is refused BEFORE anything is written or committed", async () => {
  const { dir, cleanup } = useTestDataDir("install-item-service-id-preflight");
  try {
    // Real incident: content authored for item `workflows` was installed under
    // the id `workflow-manager`. The id check ran only AFTER commitAll, so the
    // commit landed (and was later promoted) while the install itself failed —
    // leaving a committed, promotable item directory with no symlink and no
    // registered service, i.e. a second marketplace entry that could never be
    // installed. Nothing may be written or committed on this path.
    await expect(
      installItem({
        name: "Workflow Manager",
        id: "workflow-manager",
        files: {
          "app/index.html": "<!doctype html>",
          "services/service.json": JSON.stringify({ id: "workflows", name: "W", version: "1.0.0", entry: "server.js" }),
        },
      }),
    ).rejects.toThrow(/does not match item id/i);

    expect(existsSync(join(dir, "user-apps", "items", "workflow-manager"))).toBe(false);
  } finally {
    cleanup();
  }
});

// The matching-id happy path is covered by tests/apps/branch-data-root.test.ts
// ("a branch install validates a service facet but does not start it"). It is
// not duplicated here because the NON-branch path loads serviceInstaller, whose
// `@/lib/logging` directory-index import the Playwright transform cannot
// resolve — a harness limitation, not a product failure.
