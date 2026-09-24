// Unit tests for the `contentOnly` delegation guard
// (src/lib/agent/subagents/claude-runner.ts). A contentOnly run executes in the
// LIVE source checkout — it deliberately skips the Supervisor worktree every
// real source edit goes through — so the guard is what keeps a "build me an
// item" delegation from editing BOS's own tree off-branch.
//
// The `docs/dev/` case is the delicate one. An installed marketplace ITEM now
// carries its own documentation in exactly that shape
// (`docs/usage/<Name>/`, `docs/dev/<Name>/`, relative to the staging directory),
// so the literal string is legitimate content-only work. It used to be a blunt
// substring veto, which killed the WHOLE delegation — app, service and docs
// alike — and the refusal text coaches the agent to strip the offending wording,
// so the retry succeeded and shipped an item with no documentation at all.
//   npm run test:unit -- tests/agent/content-only-guard.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { isBosSourceTask, isStandaloneContentTask, bosSourceTrigger } from "../../src/lib/agent/subagents/claude-runner";

// A stand-in source checkout carrying one page BOS "ships".
function fakeSourceRoot(label: string): { root: string; cleanup: () => void } {
  const root = join(__dirname, ".tmp", `${label}-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "docs", "dev", "apps"), { recursive: true });
  writeFileSync(join(root, "docs", "dev", "architecture-overview.md"), "# Architecture\n");
  writeFileSync(join(root, "docs", "dev", "apps", "services.md"), "# Services\n");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const STAGED_ITEM_TASK =
  "Write a BOS app project into a fresh staging directory /tmp/widgets. Put the UI under app/. " +
  "Also write the item's documentation under a top-level docs/ folder: docs/usage/Widgets/usage.md " +
  "for end users and docs/dev/Widgets/architecture.md for developers.";

test("an item's own docs/dev/<Name>/ pages do NOT read as a BOS-source task", () => {
  const { root, cleanup } = fakeSourceRoot("guard-item-docs");
  try {
    expect(isStandaloneContentTask(STAGED_ITEM_TASK)).toBe(true);
    expect(isBosSourceTask(STAGED_ITEM_TASK, root)).toBe(false);
  } finally {
    cleanup();
  }
});

test("a page BOS actually ships still vetoes the run", () => {
  const { root, cleanup } = fakeSourceRoot("guard-bos-docs");
  try {
    expect(isBosSourceTask(`${STAGED_ITEM_TASK} Then update docs/dev/architecture-overview.md to match.`, root)).toBe(true);
    expect(isBosSourceTask("Write a bos app project into a staging dir, and read docs/dev/apps/services.md first.", root)).toBe(true);
  } finally {
    cleanup();
  }
});

test("traversal out of docs/dev/ is refused whether or not it resolves", () => {
  const { root, cleanup } = fakeSourceRoot("guard-traversal");
  try {
    expect(isBosSourceTask("Write a bos app project into a staging dir; also read docs/dev/../../.env.md.", root)).toBe(true);
  } finally {
    cleanup();
  }
});

test("a bare docs/dev/ with no page named is not a veto on its own", () => {
  const { root, cleanup } = fakeSourceRoot("guard-bare");
  try {
    expect(isBosSourceTask("Write a bos app project into a staging dir with docs under docs/usage/ and docs/dev/.", root)).toBe(false);
  } finally {
    cleanup();
  }
});

test("the other BOS-source signals are untouched", () => {
  const { root, cleanup } = fakeSourceRoot("guard-others");
  try {
    for (const task of [
      "Write a bos app project into a staging dir and add a settings tab for it.",
      "Write a bos app project into a staging dir, then edit src/lib/apps/store.ts.",
      "Write a bos app project into a staging dir; this needs an api route.",
      "Write a bos app project into a staging dir and change BOS source.",
    ]) {
      expect(isBosSourceTask(task, root), task).toBe(true);
    }
  } finally {
    cleanup();
  }
});

// The refusal has to say WHICH condition failed. Both used to produce the same
// paragraph, so a live session whose task merely lacked a trigger phrase read
// the BOS-source half of it and spent two more turns deleting wording that was
// never the problem — at the `implement` step, with the app already specced.
test("the refusal names the phrase that tripped it, or says the trigger is missing", () => {
  const root = process.cwd();

  // A task that reads as BOS source: the trigger is quoted back.
  expect(bosSourceTrigger("Write a bos app project; also fix the api route", root)).toBe('"api route"');
  expect(bosSourceTrigger("staging directory work under src/lib/specs/", root)).toContain("src/lib/");
  expect(bosSourceTrigger(`${STAGED_ITEM_TASK} Then update docs/dev/architecture-overview.md.`, root)).toContain(
    "docs/dev/",
  );

  // A clean item task trips nothing — so a refusal for THAT task can only be
  // the missing-trigger half, and the message can say so without hedging.
  expect(bosSourceTrigger(STAGED_ITEM_TASK, root)).toBeNull();
  expect(
    bosSourceTrigger("Implement the marketplace item by reading its spec files from /data-clones/bos/testfixture-x/user-apps/items/y/spec/", root),
    "the real session's second attempt: no BOS-source phrase in it at all",
  ).toBeNull();
});
