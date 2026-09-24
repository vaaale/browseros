// A spec store reached through a SYMLINK must still be discovered.
//
// listStores() filtered with `e.isDirectory()` on a readdir(withFileTypes)
// result, and that does NOT follow symlinks — a symlinked store reports
// isDirectory() === false and was skipped. Silently: no error, no log, the
// store simply never appeared in Build Studio, which is indistinguishable from
// the specs having been deleted.
//
// This is how a developer points BOS_SPECS_ROOT at stores kept outside the data
// dir (data/specs/<id> -> ../../../<id>), and how one set of stores can be
// shared across versions. Found on a real local install where ONLY item stores
// rendered — item stores are discovered through a different path
// (item-stores.ts) and so were unaffected, which made the failure look like a
// method-layer regression when it long predated it.
//   npm run test:unit -- tests/specs/symlinked-store-discovery.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, symlinkSync, readdirSync } from "fs";
import { execFileSync } from "child_process";
import { useTestDataDir } from "../services/_test-env";
import { specsRoot } from "../../src/os/specs-dir";
import { listStores } from "../../src/lib/specs/stores";

/** A real store repo somewhere OUTSIDE the specs root. */
function layOutStore(dir: string, manifest: object): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "spec-store.json"), JSON.stringify(manifest, null, 2));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

test("a store symlinked into the specs root is discovered", async () => {
  const { dir, cleanup } = useTestDataDir("symlinked-store");
  try {
    const root = specsRoot();
    mkdirSync(root, { recursive: true });

    // Real repo outside the root, symlinked in — the layout a developer gets
    // by pointing data/specs at stores kept beside the checkout.
    const real = layOutStore(join(dir, "elsewhere", "user-specs"), { label: "User specs", owner: "user", writable: true, requiresPromote: false });
    symlinkSync(real, join(root, "user-specs"));

    // Precondition: the entry really is a symlink, so this test would have
    // caught the original bug rather than passing vacuously.
    const entry = readdirSync(root, { withFileTypes: true }).find((e) => e.name === "user-specs")!;
    expect(entry.isSymbolicLink(), "fixture must exercise the symlink path").toBe(true);
    expect(entry.isDirectory(), "readdir does not follow symlinks — this is the trap").toBe(false);

    const stores = await listStores();
    expect(stores.map((s) => s.id), "a symlinked store must still be discovered").toContain("user-specs");
    expect(stores.find((s) => s.id === "user-specs")?.owner).toBe("user");
  } finally {
    cleanup();
  }
});

test("a symlink pointing at a non-directory, or at nothing, is skipped without throwing", async () => {
  const { dir, cleanup } = useTestDataDir("symlinked-store-bad");
  try {
    const root = specsRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(dir, "a-file"), "not a store");
    symlinkSync(join(dir, "a-file"), join(root, "file-link"));
    symlinkSync(join(dir, "does-not-exist"), join(root, "dangling"));

    // A broken symlink in the specs root must not take down discovery for
    // every other store — the same containment reasoning as a store bound to a
    // missing method.
    await expect(listStores()).resolves.toBeDefined();
    expect((await listStores()).map((s) => s.id)).not.toContain("file-link");
    expect((await listStores()).map((s) => s.id)).not.toContain("dangling");
  } finally {
    cleanup();
  }
});

// ── The Supervisor's copy of this rule ──────────────────────────────────────
//
// `tools/supervisor/lib/coupled-repos.mjs` decides which stores get mounted as a
// worktree for a feature branch. It says it uses "the same discovery rule as
// src/lib/specs/stores.ts" — and it did not. Both halves of the drift were
// silent, and each one on its own makes a store unwritable on a branch:
//
//   - it filtered on `Dirent.isDirectory()`, false for every symlinked store, so
//     in a deployment where the stores are symlinks NOTHING was ever mounted;
//   - it required `.git` INSIDE the store root, skipping any store that is a
//     subdirectory of its repo — the shape 050 gave registered repositories.
//
// Run in a CHILD PROCESS, which is how the Supervisor genuinely runs: its
// SPECS_ROOT is read at module load from the environment, so importing it here
// would bind whichever root happened to be set first.
async function supervisorStores(specsRootPath: string): Promise<Array<{ id: string; root: string; offset: string }>> {
  const { execFileSync } = await import("child_process");
  const src = `
    import { listSpecStores } from "${join(process.cwd(), "tools/supervisor/lib/coupled-repos.mjs")}";
    process.stdout.write(JSON.stringify(await listSpecStores()));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", src], {
    cwd: process.cwd(),
    // The unit suite's NODE_OPTIONS preloads a react-server condition the
    // Supervisor never runs under, and it is not what is being tested here.
    env: { ...process.env, NODE_OPTIONS: "", BOS_SPECS_ROOT: specsRootPath },
    encoding: "utf8",
  });
  return JSON.parse(out);
}

test("the Supervisor mounts exactly the stores BOS discovers — symlinks and subdirectory stores included", async () => {
  const { dir, cleanup } = useTestDataDir("supervisor-store-parity");
  try {
    const root = specsRoot();
    mkdirSync(root, { recursive: true });

    // (1) A store that IS its own repo, reached by symlink.
    const own = layOutStore(join(dir, "elsewhere", "user-specs"), { label: "User specs", owner: "user", writable: true, requiresPromote: false });
    symlinkSync(own, join(root, "user-specs"));

    // (2) A registered repository whose specs are a SUBDIRECTORY of it — the
    // 050 shape. The repo is the project; the store is the folder its method
    // chose.
    const project = join(dir, "elsewhere", "invoice-parser");
    mkdirSync(join(project, "openspec"), { recursive: true });
    writeFileSync(join(project, "README.md"), "# app\n");
    writeFileSync(join(project, "openspec", "spec-store.json"), JSON.stringify({ label: "invoice-parser", owner: "user", writable: true, requiresPromote: false, kind: "arbitrary" }));
    execFileSync("git", ["init", "-q"], { cwd: project });
    execFileSync("git", ["add", "-A"], { cwd: project });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: project });
    symlinkSync(join(project, "openspec"), join(root, "invoice-parser"));

    const bos = (await listStores()).map((s) => s.id).sort();
    const sup = await supervisorStores(root);
    expect(sup.map((s) => s.id).sort(), "the two rules must agree on the SET of stores").toEqual(bos);
    expect(bos).toEqual(["invoice-parser", "user-specs"]);

    // And on WHERE each one is: `root` is the repo a worktree is added from,
    // `offset` descends back to the store inside it. Getting the repo right but
    // the offset wrong would mount a registered project's whole source tree as
    // if it were the spec store.
    const parser = sup.find((s) => s.id === "invoice-parser")!;
    expect(parser.root, "the worktree is added from the PROJECT").toBe(project);
    expect(parser.offset, "and the store is the folder inside it").toBe("openspec");

    const userSpecs = sup.find((s) => s.id === "user-specs")!;
    expect(userSpecs.root).toBe(own);
    expect(userSpecs.offset, "a store that IS its repo needs no descent").toBe("");
  } finally {
    cleanup();
  }
});

// 050 T017 found this by DIFFING a real repository: a spec write landed at the
// repository ROOT instead of inside the method's folder.
//
// The offset from a repo down to its store was being derived as
// `path.relative(repoRoot, root)`. For a store reached by SYMLINK — the normal
// shape here — `root` is the link (`data/specs/<id>`) while `repoRoot` is the
// real path, so that relative path walks OUT of the data dir and back:
// `../../specs/police-mcp`. Joined onto a branch mount sitting at the same
// depth, it cancelled out exactly and resolved to the mount root. Right content,
// wrong directory, no error anywhere.
test("a symlinked store's offset within its repo is the real one, not a path back out of the data dir", async () => {
  const { dir, cleanup } = useTestDataDir("symlinked-store-offset");
  try {
    const root = specsRoot();
    mkdirSync(root, { recursive: true });

    // A registered repository: the repo is the project, the store is a folder in
    // it, and BOS reaches that folder through a symlink.
    const project = join(dir, "elsewhere", "invoice-parser");
    mkdirSync(join(project, "openspec"), { recursive: true });
    writeFileSync(join(project, "openspec", "spec-store.json"), JSON.stringify({ label: "invoice-parser", owner: "user", writable: true, requiresPromote: false, kind: "arbitrary" }));
    execFileSync("git", ["init", "-q"], { cwd: project });
    execFileSync("git", ["add", "-A"], { cwd: project });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: project });
    symlinkSync(join(project, "openspec"), join(root, "invoice-parser"));

    // And one that IS its own repo, also symlinked — the offset must be empty,
    // not "." or a walk.
    const own = layOutStore(join(dir, "elsewhere", "user-specs"), { label: "User specs", owner: "user", writable: true, requiresPromote: false });
    symlinkSync(own, join(root, "user-specs"));

    const stores = await listStores();
    const parser = stores.find((s) => s.id === "invoice-parser")!;
    expect(parser.repoOffset, "descends INTO the repo, never out of it").toBe("openspec");
    expect(parser.repoOffset.startsWith(".."), "an offset that escapes is the bug").toBe(false);

    expect(stores.find((s) => s.id === "user-specs")!.repoOffset, "a store that IS its repo needs no descent").toBe("");
  } finally {
    cleanup();
  }
});
