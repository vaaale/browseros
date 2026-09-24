// Unit tests for Build Studio's pure tree-walking helpers (037-project-layer,
// Phase 4). Pure logic on hand-built SpecTreeNode fixtures — no server, no
// filesystem, no git. Written BEFORE the index.tsx rewrite that consumes
// these (TDD).
//   npm run test:unit -- tests/build-studio/tree-helpers.test.ts
import { test, expect } from "@playwright/test";
import type { SpecTreeNode } from "../../src/lib/specs/types";
import { findInTree, featureIdOf, findBranchInTree, storeIdOf } from "../../src/apps/build-studio/tree-helpers";

// A store with a Project containing a nested plain folder, matching the
// shape pipeline.ts's specTree() actually produces post-033.
const NESTED_TREE: SpecTreeNode[] = [
  {
    type: "group",
    name: "user-specs",
    label: "User specs",
    path: "user-specs",
    owner: "user",
    children: [
      {
        type: "project",
        name: "assistant-app",
        label: "Assistant App",
        path: "user-specs/assistant-app",
        children: [
          {
            type: "dir",
            name: "agent-loop",
            path: "user-specs/assistant-app/agent-loop",
            children: [
              {
                type: "feature",
                name: "003-compaction",
                path: "user-specs/assistant-app/agent-loop/003-compaction",
                children: [
                  { type: "file", name: "spec.md", path: "user-specs/assistant-app/agent-loop/003-compaction/spec.md" },
                  { type: "file", name: "plan.md", path: "user-specs/assistant-app/agent-loop/003-compaction/plan.md" },
                ],
              },
            ],
          },
        ],
      },
      {
        // A second Project, inactive (no activeBranch), feature directly at its root.
        type: "project",
        name: "beta",
        label: "Beta",
        path: "user-specs/beta",
        children: [
          {
            type: "feature",
            name: "001-foo",
            path: "user-specs/beta/001-foo",
            branch: "bos/testfixture-some-draft", // a draft-branch-only feature, per 020
            children: [{ type: "file", name: "spec.md", path: "user-specs/beta/001-foo/spec.md", branch: "bos/testfixture-some-draft" }],
          },
        ],
      },
    ],
  },
  {
    type: "group",
    name: "item-widget",
    label: "Widget",
    path: "item-widget",
    owner: "item",
    children: [{ type: "feature", name: "Widget", path: "item-widget", children: [{ type: "file", name: "spec.md", path: "item-widget/spec.md" }] }],
  },
];

test("findInTree locates a deeply nested node and its full ancestor chain", () => {
  const match = findInTree(NESTED_TREE, "user-specs/assistant-app/agent-loop/003-compaction/spec.md");
  expect(match?.node.name).toBe("spec.md");
  expect(match?.ancestors.map((a) => a.path)).toEqual([
    "user-specs",
    "user-specs/assistant-app",
    "user-specs/assistant-app/agent-loop",
    "user-specs/assistant-app/agent-loop/003-compaction",
  ]);
});

test("findInTree returns null for a path not in the tree", () => {
  expect(findInTree(NESTED_TREE, "user-specs/nope")).toBeNull();
});

test("featureIdOf walks arbitrary depth to find the owning feature leaf, for a file, and for the feature itself", () => {
  expect(featureIdOf("user-specs/assistant-app/agent-loop/003-compaction/plan.md", NESTED_TREE)).toBe(
    "user-specs/assistant-app/agent-loop/003-compaction",
  );
  expect(featureIdOf("user-specs/assistant-app/agent-loop/003-compaction", NESTED_TREE)).toBe(
    "user-specs/assistant-app/agent-loop/003-compaction",
  );
});

test("featureIdOf resolves a feature sitting directly at a project's root (no intermediate plain folder)", () => {
  expect(featureIdOf("user-specs/beta/001-foo/spec.md", NESTED_TREE)).toBe("user-specs/beta/001-foo");
});

test("featureIdOf treats an item-owned store's bare store id as the feature, unaffected by the Project layer", () => {
  expect(featureIdOf("item-widget/spec.md", NESTED_TREE)).toBe("item-widget");
});

test("findBranchInTree finds a draft branch at any depth, not just a fixed 3 levels", () => {
  expect(findBranchInTree(NESTED_TREE, "user-specs/beta/001-foo/spec.md")).toBe("bos/testfixture-some-draft");
  expect(findBranchInTree(NESTED_TREE, "user-specs/beta/001-foo")).toBe("bos/testfixture-some-draft");
  // A file with no branch (base content) has none.
  expect(findBranchInTree(NESTED_TREE, "user-specs/assistant-app/agent-loop/003-compaction/spec.md")).toBe("");
});

test("storeIdOf extracts the first path segment", () => {
  expect(storeIdOf("user-specs/assistant-app/agent-loop/003-compaction/spec.md")).toBe("user-specs");
  expect(storeIdOf("item-widget/spec.md")).toBe("item-widget");
});

