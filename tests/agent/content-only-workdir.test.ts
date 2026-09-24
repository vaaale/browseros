// A run that may not touch BOS's source must not STAND IN BOS's source tree.
//
// THE FAILURE: `contentOnly: true` delegations — how a marketplace item gets
// built — ran with cwd = the LIVE checkout. The task is standalone content
// generation and is refused outright if it so much as mentions BOS source, yet
// its working directory was BOS's own repository. Every relative path it wrote
// landed there. A real session left:
//
//     M package-lock.json
//     ?? mockup-dashboard.png
//     ?? mockup-dash2.png
//
// in the repo root, and nothing failed at the time. It surfaced later, as the
// Supervisor's safety gate blocking the PREVIEW BUILD of a feature branch:
// "developer harness edited the live checkout instead of the isolated preview
// worktree" — a different operation, hours later, naming no files. The user saw
// a broken Preview button.
//
//   npm run test:unit -- tests/agent/content-only-workdir.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { join, resolve, relative, isAbsolute, sep } from "path";
import { useTestDataDir } from "../services/_test-env";
import { contentOnlyWorkDir } from "../../src/lib/agent/subagents/claude-runner";

/** Is `child` inside `parent`? String prefixes lie about `/app` vs `/appdata`,
 *  and a plain `startsWith("..")` lies about a directory literally NAMED
 *  `..-..-etc` — which is exactly what the traversal case below produces. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

test("a contentOnly run works in its own directory, not the source checkout", () => {
  const { dir, cleanup } = useTestDataDir("content-only-workdir");
  try {
    const work = contentOnlyWorkDir("claude-developer-1789595115310");

    expect(isInside(dir, work), `must be under the data dir, got ${work}`).toBe(true);
    expect(work, "and not the checkout root itself").not.toBe(process.cwd());
    expect(existsSync(work) && statSync(work).isDirectory(), "created, so spawning with it cannot ENOENT").toBe(true);

    // The property the whole fix is for: a relative write lands here.
    writeFileSync(join(work, "mockup-dashboard.png"), "x");
    expect(existsSync(join(process.cwd(), "mockup-dashboard.png")), "and NOT in the repo root").toBe(false);
  } finally {
    cleanup();
  }
});

test("two runs never share a directory, and a run id cannot escape it", () => {
  const { dir, cleanup } = useTestDataDir("content-only-workdir");
  try {
    expect(contentOnlyWorkDir("run-a")).not.toBe(contentOnlyWorkDir("run-b"));
    // A run id is server-generated, but it reaches a path — traversal in it must
    // not reach out of the scratch root.
    const nasty = contentOnlyWorkDir("../../../etc/passwd");
    expect(isInside(join(dir, "harness", "content"), nasty), `escaped: ${nasty}`).toBe(true);
  } finally {
    cleanup();
  }
});

test("whatever lands in that directory cannot make the repository dirty", () => {
  // The property that actually stops the safety gate firing. On a deployment
  // `dataDir()` is `/app/data` — INSIDE the live checkout — so "outside the
  // repo" was never the real rule and asserting it would pass here (the test
  // data dir is under tests/) while meaning nothing on the box. What matters is
  // that git does not see it: a stray PNG there leaves `git status` clean, and
  // the build gate has nothing to block.
  const ignored = (p: string) => {
    try {
      execFileSync("git", ["check-ignore", "-q", p]);
      return true;
    } catch {
      return false;
    }
  };
  expect(ignored("data/harness/content/some-run/mockup-dashboard.png"), "data/ must stay git-ignored").toBe(true);
  expect(ignored("mockup-dashboard.png"), "…whereas the repo root is NOT — which is how this was found").toBe(false);
});

test("the contentOnly branch does not hand the harness's own cwd to the CLI", () => {
  // The runner spawns a real `claude` binary, so the end-to-end path is out of
  // this suite's reach; what can be pinned is that the one line which caused
  // this does not come back. `harness.cwd` remains correct for the SOURCE path
  // below it (that one runs in the Supervisor's worktree).
  const src = readFileSync("src/lib/agent/subagents/claude-runner.ts", "utf8");
  const block = src.slice(src.indexOf("if (opts?.contentOnly) {"), src.indexOf("// Source edits must never run in the live checkout"));
  expect(block, "the contentOnly run must be given its own directory").toContain("contentOnlyWorkDir(ctx.runId)");
  expect(block, "and never the harness's cwd, which is the live checkout").not.toContain("harness.cwd, harness.timeoutMs");
});
