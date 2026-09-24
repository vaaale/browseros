// What a feature branch is FOR, and therefore which repositories it touches.
//
// THE BUG THIS EXISTS FOR
//
// `coupledReposFor` branched every spec store, unconditionally. That was right
// when the only stores were `bos-system-specs` and `user-specs`. 050 made an
// arbitrary registered repository into a spec store, so "every spec store"
// silently grew to include the user's own unrelated projects — and a change to
// one marketplace app created `bos/agentic-editor-appearance` in five
// repositories, including a user's `police-mcp` and the read-only
// `bos-system-specs`.
//
// Nothing in the Supervisor knew 050 had happened. The set was never wrong when
// it was written; it was made wrong by a feature elsewhere, and nothing failed.
//
// WHY THE SCOPE IS DECLARED AND NOT INFERRED
//
// A branch is created BEFORE anything is written to it, so there is nothing to
// infer from. The agent, however, already knows: it decides what kind of change
// this is in order to load the right skills and drive the right process. This
// records the decision it has already made, rather than asking it to make a new
// one.
//
// WHY A FILE
//
// The Supervisor is a separate process. It mounts the coupled worktrees and has
// no access to conversation state, so the scope has to live somewhere both can
// read — the same reason module selection lives in `itemConfigDir` rather than
// in memory.

import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { logger } from "@/lib/logging/server-logger";

const COMPONENT = "specs.branch-scope";
const FILE = "branch-scopes.json";

const scopesPath = (root?: string) => path.join(root ?? dataDir(), "system", FILE);

export type BranchScope =
  /** BrowserOS itself — its source, and the specs that describe it. */
  | { kind: "bos-core" }
  /** A marketplace item: its code and its spec both live in the marketplace
   *  repo, and a change to BOS's own source may accompany it.
   *
   *  `itemId` is INFORMATIONAL and optional — the repositories branched are the
   *  same for ANY item (BOS's source + user-apps), so requiring it would make
   *  the picker demand a choice that changes nothing. Recorded when known,
   *  because "which item was this for" is worth having later. */
  | { kind: "marketplace-item"; itemId?: string }
  /** A registered repository (050) that is nobody's business but its own. */
  | { kind: "repository"; repoId: string };

export const BRANCH_SCOPE_KINDS: Array<BranchScope["kind"]> = ["bos-core", "marketplace-item", "repository"];

type ScopeFile = Record<string, BranchScope>;

async function readAll(root?: string): Promise<ScopeFile> {
  try {
    return JSON.parse(await fs.readFile(scopesPath(root), "utf8")) as ScopeFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    // A scope file that exists and cannot be read is NOT "no branch has a
    // scope". Treating it as empty would silently re-enable the over-branching
    // this module exists to stop.
    logger().error(COMPONENT, "could not read branch scopes", undefined, { error: (err as Error).message });
    throw err;
  }
}

/** Record what a branch is for. Called once, when the branch is created. */
export async function setBranchScope(branch: string, scope: BranchScope, root?: string): Promise<void> {
  const all = await readAll(root);
  all[branch] = scope;
  const p = scopesPath(root);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(all, null, 2) + "\n", "utf8");
  logger().info(COMPONENT, "branch scope recorded", { branch, scope });
}

/** What a branch is for, or undefined when nothing recorded it. */
export async function getBranchScope(branch: string, root?: string): Promise<BranchScope | undefined> {
  return (await readAll(root))[branch];
}

/** Drop a branch's scope — called when the branch is promoted or discarded, so
 *  the file does not accumulate every branch that ever existed. */
export async function clearBranchScope(branch: string, root?: string): Promise<void> {
  const all = await readAll(root);
  if (!(branch in all)) return;
  delete all[branch];
  await fs.writeFile(scopesPath(root), JSON.stringify(all, null, 2) + "\n", "utf8");
}

/** Record WHICH item a marketplace branch is for, once that stops being a
 *  guess: the app has just been created, on this branch, with this id.
 *
 *  THE BUG THIS EXISTS FOR. `itemId` is optional because the branch must exist
 *  BEFORE the app does — every `app_spec_*` write is refused without one — so a
 *  branch for a NEW app is routinely created with no id to give. A live session
 *  recorded exactly `{ "kind": "marketplace-item" }`, and the tree then had
 *  nothing to attribute: no row could say it was the one being worked on, and
 *  the branch badge vanished from Build Studio entirely. That degraded state was
 *  written down as a known cost. It should never have been a lasting one — the
 *  id becomes known a few seconds later.
 *
 *  Deliberately narrow. It fills in a MISSING id on a scope that already says
 *  marketplace-item; it does not create a scope, change a kind, or overwrite an
 *  id that names a different item — a branch that was already attributed stays
 *  attributed, and a second item created on it is reported rather than allowed
 *  to steal the badge. Nothing here changes which repositories are coupled:
 *  every marketplace item couples the same two. */
export async function attributeBranchToItem(branch: string, itemId: string, root?: string): Promise<void> {
  if (!branch || !itemId) return;
  const scope = (await readAll(root))[branch];
  if (!scope) {
    // No scope at all: inventing one would decide the branch's coupling from a
    // single write, which is the Supervisor's business and not a fact this
    // knows. Reported, because a branch with items on it and no scope is worth
    // seeing.
    logger().info(COMPONENT, "item created on a branch with no recorded scope", { branch, itemId });
    return;
  }
  if (scope.kind !== "marketplace-item") {
    logger().info(COMPONENT, "item created on a branch scoped to something else; scope left alone", {
      branch,
      itemId,
      kind: scope.kind,
    });
    return;
  }
  if (scope.itemId === itemId) return;
  if (scope.itemId) {
    logger().info(COMPONENT, "branch is already attributed to another item; scope left alone", {
      branch,
      existing: scope.itemId,
      created: itemId,
    });
    return;
  }
  await setBranchScope(branch, { kind: "marketplace-item", itemId }, root);
}

/** Resolve whatever a caller called the item into THE item id, or report what
 *  the valid ones are.
 *
 *  `itemId` had two shapes in the field, from two callers, and no one noticed
 *  because neither shape was ever checked. Build Studio sends none at all; the
 *  agent sent `item-agentic-text-editor` (the store id it can see in the spec
 *  tree) where the tool declaration says "the item id". The consumer expected
 *  the bare form, prefixed it again, matched nothing, and rendered nothing —
 *  the whole failure was one silent non-match.
 *
 *  So: accept both shapes and report ONE. `ok: false` means "no INSTALLED item
 *  by that name" and carries the real ids — it is not itself a verdict. The
 *  caller decides: for a branch being created for an app that does not exist
 *  yet, an unknown id is correct and gets recorded with a warning; the ids are
 *  there so a typo still surfaces. (This did refuse outright, which made
 *  starting a new app impossible — see the route.) */
export async function resolveMarketplaceItemId(
  given: string,
): Promise<{ ok: true; itemId: string } | { ok: false; known: string[] }> {
  const { listStores } = await import("@/lib/specs/stores");
  const { ITEM_STORE_PREFIX } = await import("@/lib/specs/item-stores");
  const known = (await listStores())
    .filter((s) => s.owner === "item")
    .map((s) => s.id.slice(ITEM_STORE_PREFIX.length));
  const bare = normalizeItemId(given);
  return known.includes(bare) ? { ok: true, itemId: bare } : { ok: false, known: known.sort() };
}

/** The bare item id, whichever shape came in (`agentic-text-editor` or the
 *  store id `item-agentic-text-editor`).
 *
 *  Split out because an id that names no INSTALLED item still has to be stored
 *  in one canonical shape: a branch for an app being created names something
 *  that does not exist yet, and it must match once it does. Kept string-only —
 *  no `listStores()` — so a caller that already knows the item is absent does
 *  not pay for a scan to normalise a string. */
export function normalizeItemId(given: string): string {
  // Mirrors `ITEM_STORE_PREFIX` (item-stores.ts), which this module can only
  // reach through a dynamic import — a static one closes a cycle. Two spellings
  // of one constant is the exact shape of several bugs in this subsystem, so
  // branch-scope-item-id.test.ts asserts the two agree rather than trusting it.
  const PREFIX = "item-";
  return given.startsWith(PREFIX) ? given.slice(PREFIX.length) : given;
}

/** One line for a human or a log. */
export function describeBranchScope(scope: BranchScope): string {
  switch (scope.kind) {
    case "bos-core":
      return "BrowserOS itself — branches BOS's source and user-specs";
    case "marketplace-item":
      return scope.itemId
        ? `the marketplace item "${scope.itemId}" — branches BOS's source and user-apps`
        : "a marketplace item — branches BOS's source and user-apps";
    case "repository":
      return `the repository "${scope.repoId}" — branches that repository only`;
  }
}
