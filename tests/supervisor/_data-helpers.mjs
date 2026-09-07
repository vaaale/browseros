// Shared fixtures for the Supervisor's worktree/data-clone/coupled-repo test
// suite (042-worktree-collision hardening). Builds on top of _helpers.mjs's
// `git()` — see ITS header comment for why config.mjs's env-derived constants
// are frozen per-process at first import: every test file below does its OWN
// env setup at module load time, before any `tools/supervisor` module is
// imported, and never relies on a SECOND, different env taking effect later
// in the same process.
//
// Every helper here only ever writes under directories it creates itself
// under the OS temp dir (`mkdtempSync`) — nothing in this file ever touches
// the real repo checkout or a real data/ directory, and every fixture is
// removed by its returned `cleanup()`, called from the test's own `finally`.
import { promises as fsp } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function git(cwd, args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

async function agit(cwd, args) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  return stdout.trim();
}

/**
 * A full Supervisor environment: a "REPO" git checkout (with a minimal
 * package.json so build.mjs's `npm run build`/`npm run test-build` can be
 * pointed at a fast, fake script instead of a real Next.js build) and a
 * separate "CANONICAL_DATA" directory, matching how a real deployment keeps
 * code and data apart. Sets `BOS_REPO`/`BOS_CANONICAL_DATA`/`BOS_WORKTREES`/
 * `BOS_DATA_CLONES` — all four explicitly, so nothing can fall back to a
 * path relative to the REAL process.cwd() if a test file is ever run from
 * somewhere unexpected.
 */
export function makeSupervisorEnv(prefix = "supervisor-test-") {
  const repo = mkdtempSync(join(tmpdir(), `${prefix}repo-`));
  git(repo, ["init", "-q", "-b", "claude"]);
  // Real BOS gitignores node_modules (worktrees hydrate their own copy,
  // never committed) and the staging dirs the atomic-clone/hydrate fix uses
  // — without this, every freshly-hydrated worktree would show as "dirty"
  // from git's own point of view, which is exactly what several tests below
  // need to NOT be true.
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n*.provisioning/\n");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fake-bos", version: "0.0.0", scripts: { build: "node -e \"process.exit(0)\"" } }, null, 2));
  writeFileSync(join(repo, "README.md"), "fake bos checkout\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);

  const dataDir = mkdtempSync(join(tmpdir(), `${prefix}data-`));
  const worktrees = mkdtempSync(join(tmpdir(), `${prefix}worktrees-`));
  const clones = mkdtempSync(join(tmpdir(), `${prefix}clones-`));

  process.env.BOS_REPO = repo;
  process.env.BOS_CANONICAL_DATA = dataDir;
  process.env.BOS_WORKTREES = worktrees;
  process.env.BOS_DATA_CLONES = clones;

  return {
    repo,
    dataDir,
    worktrees,
    clones,
    baseBranch: "claude",
    cleanup: () => {
      for (const dir of [repo, dataDir, worktrees, clones]) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Marker-file trick used throughout: write a unique value into a directory,
 *  then later assert whether it's STILL there (proves "not recopied"/"not
 *  destroyed") or GONE (proves "genuinely recreated from scratch"). */
export async function writeMarker(dir, name, value) {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(join(dir, name), value);
}

export async function readMarker(dir, name) {
  try {
    return await fsp.readFile(join(dir, name), "utf8");
  } catch {
    return null;
  }
}

/** A minimal, valid spec-store repo (matches listSpecStores()'s discovery
 *  contract: a directory directly under SPECS_ROOT with its own `.git` and a
 *  `spec-store.json`), checked out on `defaultBranch`. */
export function makeSpecStore(specsRoot, id, defaultBranch = "master") {
  const root = join(specsRoot, id);
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-q", "-b", defaultBranch]);
  writeFileSync(join(root, "spec-store.json"), JSON.stringify({ id }, null, 2));
  writeFileSync(join(root, "README.md"), `${id} spec store\n`);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

export { agit };
