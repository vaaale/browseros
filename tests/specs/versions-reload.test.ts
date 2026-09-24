import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { replacesServedBuild } from "../../src/lib/supervisor/client";

// The tab imports THIS function — asserting a re-implementation of the rule
// would pass while the product did something else.
test("deleting a branch you are not running does NOT reload the window", () => {
  // The reported problem: every discard reloaded BOS, throwing the user out of
  // Settings and back to a fresh desktop — so deleting several branches meant
  // navigating back in each time. The worktree destroyed is not the one
  // answering these requests.
  const onBase = { role: "base" as const };
  expect(replacesServedBuild("discard", "bos/testfixture-some-feature", onBase)).toBe(false);
  expect(replacesServedBuild("stop", "bos/testfixture-some-feature", onBase)).toBe(false);
});

test("but discarding the preview you ARE running does", () => {
  const onPreview = { role: "preview", branch: "bos/testfixture-current" };
  expect(replacesServedBuild("discard", "bos/testfixture-current", onPreview), "its worktree is the one serving us").toBe(true);
  expect(replacesServedBuild("stop", "bos/testfixture-current", onPreview)).toBe(true);
  // A different branch, while previewing: still unaffected.
  expect(replacesServedBuild("discard", "bos/testfixture-other", onPreview)).toBe(false);
});

test("promote and pin always reload — the served build changes by definition", () => {
  for (const serving of [{ role: "base" as const }, { role: "preview", branch: "bos/testfixture-x" }, null]) {
    expect(replacesServedBuild("promote", "bos/testfixture-x", serving)).toBe(true);
    expect(replacesServedBuild("pin", "", serving)).toBe(true);
  }
});
