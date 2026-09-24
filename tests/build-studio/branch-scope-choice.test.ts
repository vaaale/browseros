// The "New feature branch" dialog's scope choice → the scope it records.
//
// The mapping is small and entirely mechanical, which is exactly the kind that
// goes wrong silently: a choice id that does not match any arm falls through to
// `undefined`, which is a LEGAL value (unscoped) rather than an error. So a typo
// in one string would quietly go back to branching BOS's repos for work on a
// user's own project.
//
//   npm run test:unit -- tests/build-studio/branch-scope-choice.test.ts
import { test, expect } from "@playwright/test";

/** The mapping as `index.tsx` performs it. Kept here as the unit under test
 *  because the component around it needs a DOM, a conversation and a live
 *  /api/repositories — none of which this rule depends on. */
function scopeFor(choiceId?: string):
  | { scope: "bos-core" }
  | { scope: "marketplace-item" }
  | { scope: "repository"; scopeId: string }
  | undefined {
  return choiceId?.startsWith("repository:")
    ? { scope: "repository" as const, scopeId: choiceId.slice("repository:".length) }
    : choiceId === "marketplace-item"
      ? { scope: "marketplace-item" as const }
      : choiceId === "bos-core"
        ? { scope: "bos-core" as const }
        : undefined;
}

test("each choice maps to the scope that branches the right repositories", () => {
  expect(scopeFor("bos-core")).toEqual({ scope: "bos-core" });
  expect(scopeFor("marketplace-item")).toEqual({ scope: "marketplace-item" });
  expect(scopeFor("repository:police-mcp"), "the reported case — a user's own project")
    .toEqual({ scope: "repository", scopeId: "police-mcp" });
});

test("a repository id containing a colon survives the prefix strip", () => {
  // `slice` past the first prefix, not `split(":")[1]` — a repo id is a
  // directory name and BOS does not get to assume it has no colon in it.
  expect(scopeFor("repository:a:b")).toEqual({ scope: "repository", scopeId: "a:b" });
});

test("no choice is UNSCOPED, which is a legal state and not an error", () => {
  // An unscoped branch couples BOS's own repos only (coupled-repos.mjs) and
  // never a registered repository — safe, and the fallback a branch created
  // before scoping existed relies on.
  expect(scopeFor(undefined)).toBeUndefined();
  expect(scopeFor("")).toBeUndefined();
});

test("an unrecognised choice does NOT silently become a scope", () => {
  // The failure this guards: a typo in a choice id would fall through to
  // undefined. That is safe (BOS-owned repos only) but it must not be mistaken
  // for a working scope, so the mapping is exhaustive over the ids the dialog
  // actually emits and anything else is undefined.
  expect(scopeFor("bos_core"), "underscore, not hyphen").toBeUndefined();
  expect(scopeFor("repository"), "the prefix without an id").toBeUndefined();
  expect(scopeFor("marketplace"), "truncated").toBeUndefined();
});
