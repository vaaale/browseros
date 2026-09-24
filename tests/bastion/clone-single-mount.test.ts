// The container layout that makes DataFS hardlink isolation possible at all.
//
// `link(2)` refuses to cross a MOUNT, even when both paths are on the same
// filesystem. The bastion used to bind the two directories separately:
//
//     …/<user>/data        -> /app/data
//     …/<user>/data-clones -> /data-clones
//
// so `cp -al /app/data /data-clones/bos/<branch>` failed with
// `Invalid cross-device link` on every file, the Supervisor fell back to
// `cp -a`, and every preview clone became a full copy of the user's data dir
// — 8.5 GB each on the box that filled 155 GB.
//
// Two directories share a mount only if one mount covers both, and the only
// directory covering these is their parent. So the parent is bound once at
// /bos, and the Supervisor's clone layer addresses the data dir through it
// (`BOS_CLONE_SOURCE=/bos/data`) with the clone root beside it
// (`BOS_DATA_CLONES=/bos/data-clones`).
//
// `BOS_DATA_DIR` deliberately stays `/app/data`: `installItemLink` writes
// `data/system/<id>` as an ABSOLUTE symlink, so re-addressing the data dir
// itself would break every installed item in every existing container.
//
//   npm run test:unit -- tests/bastion/clone-single-mount.test.ts
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { join } from "path";

const DOCKER_TS = readFileSync(join(__dirname, "..", "..", "bastion", "src", "docker.ts"), "utf8");

/** The container spec is built inline in createBosContainer; asserting on the
 *  source is crude but honest — the alternative is standing up dockerode
 *  against a real daemon, which is an e2e concern, not a unit one. What must
 *  not regress is the RELATIONSHIP between these paths, and that is visible
 *  here. */
function specText(): string {
  return DOCKER_TS;
}

test("the user's directory is bound once, so data/ and data-clones/ share a mount", () => {
  expect(
    specText(),
    "without a mount covering both, link(2) returns EXDEV and every clone is a full copy",
  ).toContain("`${userPath}:/bos`");
});

test("the clone source and the clone root are both addressed through that one mount", () => {
  const spec = specText();
  expect(spec).toContain("BOS_CLONE_SOURCE=/bos/data");
  expect(spec).toContain("BOS_DATA_CLONES=/bos/data-clones");
});

test("BOS itself still uses /app/data — re-addressing it would break every installed item's symlink", () => {
  const spec = specText();
  expect(spec).toContain("BOS_DATA_DIR=/app/data");
  expect(spec).toContain("`${dataPath}:/app/data`");
});

test("the clone root is no longer bound at its own separate path", () => {
  // A leftover `…:/data-clones` bind would be harmless but misleading: it
  // would keep working, and keep producing full copies, for anything still
  // pointed at the old path.
  expect(specText()).not.toMatch(/`\$\{\w+\}:\/data-clones`/);
});

test("worktrees stay outside /app so chownSrc never walks them", () => {
  // Unrelated to the hardlink fix and easy to break while moving mounts
  // around: a worktree holds a full source tree plus node_modules.
  expect(specText()).toContain("`${worktreesPath}:/worktrees`");
  expect(specText()).toContain("BOS_WORKTREES=/worktrees");
});
