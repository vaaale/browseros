// REPRODUCTION: the branch badge shows on nothing (or everything), because the
// PRODUCER and the CONSUMER of `itemId` disagree about what an item id is.
//
// The live scope file, written by the real product:
//     { "bos/testfixture-agentic-text-v4": { kind: "marketplace-item",
//                                       itemId: "item-agentic-text-editor" } }
// The consumer (pipeline.ts) did `item-${itemId}` -> "item-item-agentic-text-editor",
// which matches no store, so no row was badged at all. The run before that
// recorded the BARE "agentic-text-editor" and worked. Same field, two shapes,
// depending on which caller filled it in — the agent sends the store id it can
// see in the tree, the tool declaration asks for "the item id".
//
// WHY THIS FILE EXISTS RATHER THAN MORE CASES IN THE BADGE TEST:
// tests/specs/item-store-branch-badge.test.ts hard-codes the bare id and passes.
// It tested the consumer against an id the consumer already agreed with — the
// same mistake as testing coupledReposFor while the branch was created by its
// twin. A reproduction has to start where the data really comes from, so this
// drives the ROUTE that writes the scope and then reads the tree that renders
// it.
//   npm run test:unit -- tests/specs/branch-scope-item-id.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync, symlinkSync } from "fs";
import { execFileSync } from "child_process";
import { NextRequest } from "next/server";
import { useTestDataDir } from "../services/_test-env";
import { POST } from "../../src/app/api/assistant/feature-branches/route";
import { getBranchScope } from "../../src/lib/specs/branch-scope";
import { specTree } from "../../src/lib/specs/pipeline";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function layOutItems(dataDir: string, ids: string[]): void {
  const apps = join(dataDir, "user-apps");
  mkdirSync(apps, { recursive: true });
  git(apps, ["init", "-q", "-b", "master"]);
  writeFileSync(join(apps, "marketplace.json"), JSON.stringify({ items: [] }, null, 2));
  for (const id of ids) {
    const itemPath = join(apps, "items", id);
    mkdirSync(join(itemPath, "spec"), { recursive: true });
    writeFileSync(join(itemPath, "spec", "spec.md"), `# ${id}\n`);
    mkdirSync(join(dataDir, "system"), { recursive: true });
    symlinkSync(itemPath, join(dataDir, "system", id));
  }
  git(apps, ["add", "-A"]);
  git(apps, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "items"]);
}

/** POST the route exactly as the agent's dev_branch_request does. The
 *  Supervisor guard makes createFeatureBranch throw (which the route treats as
 *  success, by design), so no branch is ever cut in the real checkout. */
async function createBranch(body: Record<string, unknown>) {
  const prev = process.env.BOS_SUPERVISOR_URL;
  process.env.BOS_SUPERVISOR_URL = "http://127.0.0.1:65535";
  try {
    const res = await POST(
      new NextRequest("http://localhost/api/assistant/feature-branches", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  } finally {
    if (prev === undefined) delete process.env.BOS_SUPERVISOR_URL;
    else process.env.BOS_SUPERVISOR_URL = prev;
  }
}

const ITEMS = ["agentic-text-editor", "lunar-lander", "terminal"];

// Both shapes are things the product actually sent: the bare item id (the tool
// declaration's wording) and the store id (what the agent sees in the tree).
for (const sent of ["agentic-text-editor", "item-agentic-text-editor"]) {
  test(`scopeId "${sent}" badges the agentic-text-editor row`, async () => {
    const { dir: dataDir, cleanup } = useTestDataDir("branch-scope-item-id");
    try {
      layOutItems(dataDir, ITEMS);
      const branch = "bos/testfixture-agentic-text-v4";

      const { status, json } = await createBranch({ name: branch, scope: "marketplace-item", scopeId: sent });
      expect(status, `route refused a scopeId the product itself sends: ${JSON.stringify(json)}`).toBe(200);

      // Stored in ONE canonical shape, whichever shape came in — otherwise every
      // reader has to guess, which is the bug.
      expect((await getBranchScope(branch))?.itemId).toBe("agentic-text-editor");

      const badged = (await specTree(branch)).filter((g) => g.liveBranch).map((g) => g.path);
      expect(badged).toEqual(["item-agentic-text-editor"]);
    } finally {
      cleanup();
    }
  });
}

test("a NEW app's id is accepted — the branch exists before the item does", async () => {
  const { dir: dataDir, cleanup } = useTestDataDir("branch-scope-item-id");
  try {
    layOutItems(dataDir, ITEMS);
    const branch = "bos/testfixture-follow-the-money";

    // The reported failure. Creating a marketplace app called "Follow the
    // Money" needs a branch FIRST — app_spec_* and app_build are all refused
    // without one — so `dev_branch_request` necessarily names an item that does
    // not exist yet. Requiring the id to already be installed made the single
    // most common marketplace flow, starting a NEW app, impossible:
    //
    //   scopeId "follow-the-money" is not an installed marketplace item.
    //   Pass one of: agentic-text-editor, bmad, falling-blocks, ...
    const { status, json } = await createBranch({
      name: branch,
      scope: "marketplace-item",
      scopeId: "follow-the-money",
    });

    expect(status, `a new app's id must not be refused: ${JSON.stringify(json)}`).toBe(200);
    expect(await getBranchScope(branch)).toEqual({ kind: "marketplace-item", itemId: "follow-the-money" });

    // Not silent, though: an id matching nothing installed is REPORTED, so a
    // typo is still visible instead of quietly producing a branch that can
    // never be attributed to anything. A `note`, not a `warning` — the message
    // says the situation is correct, and a warning would contradict it.
    expect(String(json.note ?? ""), "the response says the id matches nothing yet").toContain("follow-the-money");
    expect(String(json.note ?? ""), "and names what IS installed, so a typo shows").toContain("agentic-text-editor");
    expect(json.warning, "nothing went wrong, so nothing is reported as a warning").toBeUndefined();
  } finally {
    cleanup();
  }
});

test("once the app exists under that id, the branch attributes to it", async () => {
  const { dir: dataDir, cleanup } = useTestDataDir("branch-scope-item-id");
  try {
    // createItemSpec slugifies the NAME, so "Follow the Money" becomes the item
    // id "follow-the-money" — the same string dev_branch_request recorded. The
    // scope is therefore self-correcting: it points at nothing for as long as
    // the app does not exist, and at the app the moment it does.
    layOutItems(dataDir, [...ITEMS, "follow-the-money"]);
    const branch = "bos/testfixture-follow-the-money";
    await createBranch({ name: branch, scope: "marketplace-item", scopeId: "follow-the-money" });

    const badged = (await specTree(branch)).filter((g) => g.liveBranch).map((g) => g.path);
    expect(badged).toEqual(["item-follow-the-money"]);
  } finally {
    cleanup();
  }
});

test("marketplace-item with NO scopeId is a DEGRADED branch, not a working one", async () => {
  const { dir: dataDir, cleanup } = useTestDataDir("branch-scope-item-id");
  try {
    layOutItems(dataDir, ITEMS);
    const branch = "bos/testfixture-unspecified-item";

    // This used to assert "still works — nothing is badged, which is honest,
    // not broken". That was the gap written down as intended behaviour, and it
    // is why the suite stayed green while Build Studio's picker could only ever
    // send this shape: the branch couples the right repositories, and then no
    // row in the tree can say which item it belongs to.
    //
    // Still ACCEPTED — the coupling is identical for any item, and refusing
    // would break a caller that legitimately does not know yet. But the
    // consequence is what is asserted, so nobody reads this case as fine.
    //
    // It is no longer a LASTING state: creating an app on such a branch fills
    // the id in (createItemSpec -> attributeBranchToItem), which is covered in
    // agent-creates-app-on-branch.test.ts. What this case pins is the window
    // before that — a branch cut and not yet built on.
    const { status } = await createBranch({ name: branch, scope: "marketplace-item" });
    expect(status).toBe(200);
    expect(await getBranchScope(branch)).toEqual({ kind: "marketplace-item" });

    const badged = (await specTree(branch)).filter((g) => g.liveBranch).map((g) => g.path);
    expect(badged, "with no itemId nothing can be attributed — this is the cost, not the design").toEqual([]);
  } finally {
    cleanup();
  }
});

test("Build Studio's picker never produces that degraded branch", async () => {
  const { dir: dataDir, cleanup } = useTestDataDir("branch-scope-item-id");
  try {
    layOutItems(dataDir, ITEMS);

    // The dialog builds its marketplace choices from the spec tree's item
    // groups, one per item, each carrying that item's store id (index.tsx's
    // `itemScopeChoices`). Mirrored here so a regression to one lump
    // "A marketplace item" choice fails rather than silently returning to a
    // branch that cannot be attributed.
    const items = (await specTree()).filter((g) => g.owner === "item").map((g) => g.path);
    expect(items.sort(), "the picker offers one choice per installed item").toEqual(
      ITEMS.map((i) => `item-${i}`).sort(),
    );

    // And what it sends for one of them resolves to that item.
    const branch = "bos/testfixture-from-the-picker";
    const { status } = await createBranch({ name: branch, scope: "marketplace-item", scopeId: "item-agentic-text-editor" });
    expect(status).toBe(200);
    expect((await specTree(branch)).filter((g) => g.liveBranch).map((g) => g.path)).toEqual([
      "item-agentic-text-editor",
    ]);
  } finally {
    cleanup();
  }
});

test("normalizeItemId and ITEM_STORE_PREFIX are the same constant", async () => {
  // branch-scope.ts spells the prefix literally because a static import of
  // item-stores.ts would close a cycle. If the real constant ever changes, a
  // new app's scope would be stored under a shape no reader matches — silently,
  // which is how the itemId bug behaved the first time.
  const { normalizeItemId } = await import("../../src/lib/specs/branch-scope");
  const { ITEM_STORE_PREFIX } = await import("../../src/lib/specs/item-stores");
  expect(normalizeItemId(`${ITEM_STORE_PREFIX}widget`)).toBe("widget");
  expect(normalizeItemId("widget"), "a bare id is already normal").toBe("widget");
});
