// Unit tests for branchDataRoot() (src/lib/devharness/branch-data-root.ts) and
// installItem()'s use of it.
//
// dataDir() is a per-process constant by design: base and every preview each
// have a fixed data root. So a write that belongs to a FEATURE BRANCH but is
// made from base has to be redirected into that branch's data clone — the same
// clone the Supervisor mounts the branch-coupled user-apps worktree into.
// Without that redirect, item CONTENT (installItem) and item SPECS
// (dev/spec-fs.ts) disagree about where a branch's work goes, purely because
// one was written against dataDir() and the other against a resolved root.
//
// The redirect itself needs a live Supervisor, so what is asserted here are the
// three no-redirect cases (which are exactly the ones that must NOT throw or
// silently relocate) plus the fact that a branch-carrying install is no longer
// refused outright.
//   npm run test:unit -- tests/apps/branch-data-root.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { existsSync } from "fs";
import { useTestDataDir } from "../services/_test-env";
import { branchDataRoot } from "../../src/lib/devharness/branch-data-root";
import { installItem } from "../../src/lib/apps/store";

test("no branch resolves to this process's own data root", async () => {
  const { dir, cleanup } = useTestDataDir("branch-data-root-none");
  try {
    expect(await branchDataRoot()).toBe(dir);
    expect(await branchDataRoot("")).toBe(dir);
  } finally {
    cleanup();
  }
});

test("inside a preview, a branch is still resolved via the Supervisor — never short-circuited to the local root", async () => {
  const { cleanup } = useTestDataDir("branch-data-root-preview");
  const prevLabel = process.env.BOS_VERSION_LABEL;
  const prevSup = process.env.BOS_SUPERVISOR_URL;
  process.env.BOS_VERSION_LABEL = "preview";
  process.env.BOS_SUPERVISOR_URL = "http://127.0.0.1:1"; // nothing listening
  try {
    // This used to short-circuit on BOS_VERSION_LABEL alone and return the
    // local root. The pin (which preview you are viewing) and the
    // conversation's active feature branch are INDEPENDENT — on bos/A's
    // preview with bos/B active, that silently committed bos/B's work onto
    // bos/A. Asking the Supervisor is the only way to get the right clone, so
    // an unreachable Supervisor must fail loudly rather than resolve locally.
    await expect(branchDataRoot("bos/some-feature")).rejects.toThrow(/Supervisor request failed/i);
  } finally {
    if (prevLabel === undefined) delete process.env.BOS_VERSION_LABEL;
    else process.env.BOS_VERSION_LABEL = prevLabel;
    if (prevSup === undefined) delete process.env.BOS_SUPERVISOR_URL;
    else process.env.BOS_SUPERVISOR_URL = prevSup;
    cleanup();
  }
});

test("with no Supervisor, a branch resolves to the live root — the branch is recorded by the git checkout, not by path", async () => {
  const { dir, cleanup } = useTestDataDir("branch-data-root-standalone");
  try {
    expect(await branchDataRoot("bos/some-feature")).toBe(dir);
  } finally {
    cleanup();
  }
});

test("a draft install carrying a branch is no longer refused, and lands under that root", async () => {
  const { dir, cleanup } = useTestDataDir("branch-data-root-install");
  try {
    // Previously this threw ("Cannot draft an install from the base version"),
    // which made the assistant's whole build-an-app flow unusable from base.
    const res = await installItem(
      { name: "Widget", files: { "app/index.html": "<!doctype html><title>w</title>" } },
      { draft: true, branch: "bos/some-feature" },
    );
    expect(res.app?.name).toBe("Widget");
    expect(existsSync(join(dir, "user-apps", "items", "widget", "app", "index.html"))).toBe(true);
    // The install symlink lands under the SAME root as the content — a split
    // between the two is what "half-landed install" would look like.
    expect(existsSync(join(dir, "system", "widget"))).toBe(true);
  } finally {
    cleanup();
  }
});

test("a branch install reports the branch and does NOT claim to be installed here", async () => {
  const { dir, cleanup } = useTestDataDir("branch-data-root-not-local");
  try {
    // With no Supervisor the resolved root IS this root, so the install is
    // local and `branch` must be absent — otherwise every standalone install
    // would wrongly tell the user to go find a preview.
    const local = await installItem(
      { name: "Local Widget", files: { "app/index.html": "<!doctype html><title>l</title>" } },
      { draft: true, branch: "bos/some-feature" },
    );
    expect(local.branch).toBeUndefined();
    expect(existsSync(join(dir, "system", "local-widget"))).toBe(true);
  } finally {
    cleanup();
  }
});

// ── The redirect itself ───────────────────────────────────────────────────────
// Everything above covers the cases where NO redirect happens. The redirect is
// where both bugs found in review actually lived, so it is exercised here
// against a stub Supervisor: a real one is a whole process tree, but the only
// thing branchDataRoot needs from it is begin's `dataDir`, and the only thing
// that matters afterwards is that EVERY path an install touches follows it.

import { createServer, type Server } from "node:http";
import { mkdirSync as mkdir, readFileSync, readlinkSync, symlinkSync } from "node:fs";

async function withStubSupervisor(clone: string, fn: () => Promise<void>): Promise<void> {
  let server: Server | undefined;
  const prev = process.env.BOS_SUPERVISOR_URL;
  try {
    server = createServer((req, res) => {
      if (req.url?.endsWith("/__supervisor/begin")) {
        res.writeHead(200, { "content-type": "application/json" });
        // Exactly the shape control.mjs's `begin` returns.
        res.end(JSON.stringify({ ok: true, branch: "bos/some-feature", worktree: `${clone}-wt`, dataDir: clone }));
        return;
      }
      res.writeHead(404).end("{}");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    process.env.BOS_SUPERVISOR_URL = `http://127.0.0.1:${port}`;
    await fn();
  } finally {
    if (prev === undefined) delete process.env.BOS_SUPERVISOR_URL;
    else process.env.BOS_SUPERVISOR_URL = prev;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }
}

test("on base, a branch install lands entirely in the branch's clone — content, symlink and config together", async () => {
  const { dir, cleanup } = useTestDataDir("branch-data-root-redirect");
  const clone = join(dir, "..", `${dir.split("/").pop()}-clone`);
  try {
    // The clone must already have user-apps mounted — branchDataRoot refuses
    // otherwise rather than writing a branch's work into the live directory.
    mkdir(join(clone, "user-apps"), { recursive: true });
    await withStubSupervisor(clone, async () => {
      expect(await branchDataRoot("bos/some-feature")).toBe(clone);

      const res = await installItem(
        {
          name: "Redirected",
          files: {
            "app/index.html": "<!doctype html><title>r</title>",
            "config/settings.json": "{}",
          },
        },
        { draft: true, branch: "bos/some-feature" },
      );

      // Reported as landing on the branch, so the caller does not register it
      // in a version that cannot serve it.
      expect(res.branch).toBe("bos/some-feature");

      // Content, install symlink and seeded config all in the CLONE...
      expect(existsSync(join(clone, "user-apps", "items", "redirected", "app", "index.html"))).toBe(true);
      expect(existsSync(join(clone, "system", "redirected"))).toBe(true);
      expect(existsSync(join(clone, "system", "config", "redirected"))).toBe(true);

      // ...and NOTHING in the live root. A split between the two is the
      // "half-landed install" this must never produce.
      expect(existsSync(join(dir, "user-apps", "items", "redirected"))).toBe(false);
      expect(existsSync(join(dir, "system", "redirected"))).toBe(false);
      expect(existsSync(join(dir, "system", "config", "redirected"))).toBe(false);

      // The commit landed in the clone's user-apps repo, not the live one.
      expect(existsSync(join(clone, "user-apps", ".git"))).toBe(true);
    });
  } finally {
    cleanup();
  }
});

test("a branch install validates a service facet but does not start it — the branch's preview does that on boot", async () => {
  const { dir, cleanup } = useTestDataDir("branch-data-root-service");
  const clone = join(dir, "..", `${dir.split("/").pop()}-clone`);
  try {
    mkdir(join(clone, "user-apps"), { recursive: true });
    await withStubSupervisor(clone, async () => {
      const manifest = { id: "svc-item", name: "Svc", version: "1.0.0", entry: "server.js", runtime: "node" };
      const res = await installItem(
        {
          name: "Svc Item",
          id: "svc-item",
          files: { "services/service.json": JSON.stringify(manifest), "services/server.js": "// noop\n" },
        },
        { draft: true, branch: "bos/some-feature" },
      );
      expect(res.branch).toBe("bos/some-feature");
      expect(res.service?.id).toBe("svc-item");
      // Validated from the clone, and no runtime state was written for it here:
      // registering it would run a preview's service against base's registry.
      expect(existsSync(join(clone, "user-apps", "items", "svc-item", "services", "service.json"))).toBe(true);
      expect(existsSync(join(dir, "system", "config", "svc-item", "runtime.json"))).toBe(false);
    });
  } finally {
    cleanup();
  }
});

test("a branch whose clone has no user-apps mount is refused, not written live", async () => {
  const { dir, cleanup } = useTestDataDir("branch-data-root-unmounted");
  const clone = join(dir, "..", `${dir.split("/").pop()}-nomount`);
  try {
    mkdir(clone, { recursive: true }); // clone exists but user-apps is NOT mounted
    await withStubSupervisor(clone, async () => {
      await expect(branchDataRoot("bos/some-feature")).rejects.toThrow(/not mounted/i);
      await expect(
        installItem({ name: "Nope", files: { "app/index.html": "<!doctype html>" } }, { draft: true, branch: "bos/some-feature" }),
      ).rejects.toThrow(/not mounted/i);
      expect(existsSync(join(dir, "user-apps", "items", "nope"))).toBe(false);
    });
  } finally {
    cleanup();
  }
});

test("updating an ALREADY-INSTALLED item on a branch is not refused as a foreign source", async () => {
  const { dir, cleanup } = useTestDataDir("branch-data-root-reinstall");
  const clone = join(dir, "..", `${dir.split("/").pop()}-reclone`);
  try {
    mkdir(join(clone, "user-apps"), { recursive: true });

    // The item is already installed in BASE, the normal state for anything the
    // user is iterating on.
    await installItem({ name: "Workflows", id: "workflows", files: { "app/index.html": "<!doctype html><title>v1</title>" } });
    expect(existsSync(join(dir, "system", "workflows"))).toBe(true);

    // A data clone inherits base's system/ symlinks VERBATIM, and they are
    // absolute — so the clone's link for this item points back into base. This
    // is what prod actually looks like.
    mkdir(join(clone, "system"), { recursive: true });
    symlinkSync(join(dir, "user-apps", "items", "workflows"), join(clone, "system", "workflows"));

    await withStubSupervisor(clone, async () => {
      // Comparing absolute paths, this read as "already installed from a
      // different source (/base/user-apps/items/workflows)" and refused —
      // permanently, since uninstalling in base leaves the clone's link intact.
      // It is the same item, just its pre-branch copy.
      const res = await installItem(
        { name: "Workflows", id: "workflows", files: { "app/index.html": "<!doctype html><title>v2</title>" } },
        { draft: true, branch: "bos/some-feature" },
      );
      expect(res.branch).toBe("bos/some-feature");
      expect(readFileSync(join(clone, "user-apps", "items", "workflows", "app", "index.html"), "utf8")).toContain("v2");
      // The clone's link is repointed at the clone's own copy, so the branch's
      // preview serves the branch's content rather than base's.
      const target = readlinkSync(join(clone, "system", "workflows"));
      expect(target).toBe(join(clone, "user-apps", "items", "workflows"));
    });
  } finally {
    cleanup();
  }
});

test("a genuinely different source for the same id is still refused", async () => {
  const { dir, cleanup } = useTestDataDir("branch-data-root-real-conflict");
  const clone = join(dir, "..", `${dir.split("/").pop()}-conflictclone`);
  try {
    mkdir(join(clone, "user-apps"), { recursive: true });
    // Same id, but owned by a marketplace clone — a real collision the flat
    // system/ namespace cannot represent, and the guard must still catch it.
    const foreign = join(dir, "marketplace", "somemkt", "items", "workflows");
    mkdir(foreign, { recursive: true });
    mkdir(join(clone, "system"), { recursive: true });
    symlinkSync(foreign, join(clone, "system", "workflows"));

    await withStubSupervisor(clone, async () => {
      await expect(
        installItem(
          { name: "Workflows", id: "workflows", files: { "app/index.html": "<!doctype html>" } },
          { draft: true, branch: "bos/some-feature" },
        ),
      ).rejects.toThrow(/already installed from a different source/i);
    });
  } finally {
    cleanup();
  }
});
