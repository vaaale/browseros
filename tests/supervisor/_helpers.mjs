// Shared fixture for the Supervisor pull-before-branch-create tests
// (037-project-layer, Phase 3). Each test file below is run as its OWN node
// process (`node --test` isolates by file, not by individual test) — this
// matters because config.mjs reads BOS_REPO/BOS_CANONICAL_DATA from the
// environment at MODULE LOAD time via `export const`, so once ANY module in
// this process has imported config.mjs (even transitively, via a
// differently-query-stringed entry point), that value is frozen for the rest
// of the process — a second test in the same file/process would silently
// keep reusing the first test's (by-then-deleted) repo/dataDir.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function git(cwd, args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

export function makeRepoWithEnv() {
  const repo = mkdtempSync(join(tmpdir(), "supervisor-pull-repo-"));
  git(repo, ["init", "-q"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  const dataDir = mkdtempSync(join(tmpdir(), "supervisor-pull-data-"));
  process.env.BOS_REPO = repo;
  process.env.BOS_CANONICAL_DATA = dataDir;
  return {
    repo,
    dataDir,
    cleanup: () => {
      rmSync(repo, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
