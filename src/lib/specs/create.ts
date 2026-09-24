import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { installItem, isSafeItemId } from "@/lib/apps/store";
import { getInstalledItem, isItemInstalled, RESERVED_ITEM_IDS, type InstalledItem } from "@/system/items/installed";
import { ITEM_STORE_PREFIX } from "./item-stores";

// Marketplace-item specs are decided up front (overriding 018/specify's original
// "always centralize in user-specs, classify late via an App Target field"
// convention — a deliberate product decision, not an oversight) and land INSIDE
// the item itself, via the SAME installItem() chokepoint app/service code goes
// through (035) — never a second, parallel write path into user-apps.

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `item-${Date.now().toString(36)}`;
}

async function uniqueItemId(base: string): Promise<string> {
  let id = base;
  for (let n = 2; await isItemInstalled(id); n++) id = `${base}-${n}`;
  return id;
}

/** 045 FR-015: the primary artifact is whatever the active method calls it,
 *  not the literal "spec.md". An item store created under a framework whose
 *  leaf marker is `proposal.md` would otherwise be written with a spec.md
 *  nothing then discovers. */
async function primaryArtifactName(workflow?: string): Promise<string> {
  const { leafMarkerFor } = await import("./leaf");

  // 049 FR-002: an explicitly named workflow wins, so "create a document
  // processing app using the bmad-enterprise workflow" gets THAT method's
  // artifact name rather than the default's.
  if (workflow) {
    const { resolveWorkflow } = await import("./method/workflows");
    return leafMarkerFor(resolveWorkflow(workflow).method);
  }

  // Nothing exists yet to resolve against, so this is the DEFAULT question,
  // asked by name rather than by assembling a partial binding — which is how
  // this line came to pass an EMPTY one and make Settings' default inert.
  const { defaultMethod } = await import("./pipeline");
  return leafMarkerFor(await defaultMethod());
}

async function itemHasSpec(item: InstalledItem): Promise<boolean> {
  try {
    // Deliberately unparameterised: this asks whether THIS item already has a
    // primary artifact, which is a question about the item's own binding — not
    // about a workflow being requested for some other item.
    await fs.access(path.join(item.itemPath, "spec", await primaryArtifactName()));
    return true;
  } catch {
    return false;
  }
}

// installItem()'s own id-collision handling is check-then-act with no lock —
// two concurrent createItemSpec calls for the same name/id could both pass
// the "not installed yet"/"no spec yet" checks below before either actually
// writes, silently clobbering one another. Serialize on the CANDIDATE id (the
// explicit id, or the base slug two same-named auto-id calls would both
// compute) so the second call always observes the first's result. Chains onto
// the previous call for the same key regardless of its outcome (`.then(fn,
// fn)`), so a rejected call never wedges the queue for that key.
const creationLocks = new Map<string, Promise<unknown>>();
function withCreationLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = creationLocks.get(key) ?? Promise.resolve();
  const result = prior.then(fn, fn);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  creationLocks.set(key, settled);
  // Bound growth: once this chain settles, drop the entry — UNLESS a newer
  // call already queued behind it and replaced the map entry, in which case
  // that newer entry must be left alone. Without this, every distinct
  // name/id ever passed to createItemSpec would leave a permanent Map entry
  // for the life of the process.
  void settled.then(() => {
    if (creationLocks.get(key) === settled) creationLocks.delete(key);
  });
  return result;
}

export interface CreateItemSpecInput {
  name: string;
  /** Explicit item id (new or existing). Omit to derive a fresh, collision-free id from `name`. */
  id?: string;
  specBody: string;
  /** 049 FR-002: the workflow this item's specs are authored under. Decides the
   *  PRIMARY ARTIFACT'S NAME, so it must be known at creation — binding
   *  afterwards orphans the first artifact, which was written under the old
   *  method's leaf marker and is not discovered by the new one. */
  workflow?: string;
  /** The active `bos/*` feature branch. REQUIRED: creating an item's spec is a
   *  write to `user-apps`, and every write to a writable spec store is
   *  branch-gated (dev/spec-fs.ts's prepareWrite). Without this, app_spec_create
   *  was the one hole left in that rule — it reaches user-apps through
   *  installItem() rather than through spec-fs, so spec-fs's own gate never
   *  saw it and a brand-new item's spec went live with no branch at all. */
  branch?: string;
}

/** Create (or add a spec to) a marketplace item, via installItem() — the item is
 *  real, symlinked, and git-committed the moment its spec exists, even before any
 *  app/service/plugin code does. Refuses (before writing anything) if the id is
 *  reserved, already belongs to a marketplace-sourced item, or already has a spec
 *  — the last case points the caller at the edit tools instead, mirroring the
 *  existing spec_write-vs-spec_edit distinction. The reserved-id and
 *  marketplace-origin checks are ALSO enforced inside installItem() itself now
 *  (the actual root fix, protecting app_install/app_build too) — repeating them
 *  here is deliberate, not drift: it gives a clearer, spec-creation-specific
 *  error before even attempting the write, and (unlike installItem()'s own
 *  check) runs inside the lock below, so it's also race-free against a second
 *  concurrent createItemSpec call for the same id.
 *
 *  Branch-gated exactly like every other spec write: refused outright without
 *  an active feature branch (unconditionally — NOT contingent on a Supervisor
 *  being present, mirroring prepareWrite), and installed as a draft so that
 *  under the Supervisor it lands on that branch's coupled user-apps worktree
 *  rather than on the live checkout. */
export async function createItemSpec(input: CreateItemSpecInput): Promise<{ id: string; path: string }> {
  const name = input.name.trim();
  if (!name) throw new Error("A name is required.");
  if (!input.branch) {
    throw new Error(
      "Creating an item's spec needs an active feature branch. Call dev_branch_request (task = a one-line description of this work), " +
        "wait for the user to confirm the branch name, then retry this exact call. Do not look for another tool.",
    );
  }
  const branch = input.branch;
  const explicitId = input.id?.trim();
  if (explicitId !== undefined) {
    if (!explicitId) throw new Error("id must not be empty.");
    if (!isSafeItemId(explicitId)) {
      throw new Error(`Invalid item id "${explicitId}": must contain only letters, digits, '.', '_', '-', and not be "." or "..".`);
    }
  }
  const lockKey = explicitId ?? slugify(name);

  return withCreationLock(lockKey, async () => {
    const id = explicitId ?? (await uniqueItemId(lockKey));
    if (RESERVED_ITEM_IDS.has(id)) {
      throw new Error(`"${id}" is a reserved item id and cannot be used.`);
    }
    const existing = await getInstalledItem(id);
    if (existing && existing.origin !== "local") {
      throw new Error(`Item "${id}" is already installed from a marketplace, not your own — pick a different id.`);
    }
    if (existing && (await itemHasSpec(existing))) {
      throw new Error(`Item "${id}" already has a spec — use app_spec_write/app_spec_edit/app_spec_patch to modify it.`);
    }
    const primary = await primaryArtifactName(input.workflow);
    await installItem({ name, id, files: { [`spec/${primary}`]: input.specBody } }, { draft: true, branch: input.branch });
    // BIND AT BIRTH, here rather than in each caller. The workflow already
    // decided this file's NAME; recording it is the other half of the same
    // fact, and leaving it to the caller is why an app created by the AGENT
    // ("build an app using the BMAD method") came out reporting the global
    // default — Build Studio's dialog bound afterwards, app_spec_create did
    // not, and nothing said so. One creation path, one binding.
    if (input.workflow) {
      const { resolveWorkflow } = await import("./method/workflows");
      const { setItemWorkflow } = await import("./item-binding");
      await setItemWorkflow(id, resolveWorkflow(input.workflow).qualified, input.branch);
    }
    // The branch now knows which item it is for. It usually could not know
    // before: the branch is created first, so a new app's id does not exist yet
    // to be passed to dev_branch_request — and an unattributed marketplace
    // branch is one no row in the tree can badge.
    const { attributeBranchToItem } = await import("./branch-scope");
    await attributeBranchToItem(branch, id);
    return { id, path: `${ITEM_STORE_PREFIX}${id}/${primary}` };
  });
}
