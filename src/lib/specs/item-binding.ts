// 049 — write an item store's binding.
//
// The READ side lives in item-stores.ts: an item store is synthesised from a
// directory scan and has no manifest of its own, so its binding lives in the
// item's own `spec/spec-store.json` and travels with the item when published.
// This is the matching write.

import "server-only";
import * as specfs from "@/lib/dev/spec-fs";
import { STORE_MANIFEST } from "./stores";
import { ITEM_STORE_PREFIX } from "./item-stores";

/** Bind an item to a workflow, at birth or later.
 *
 *  MERGE, never reconstruct (045 FR-019). BOS rewrites this file, so a key this
 *  function does not model is not merely ignored — it is deleted from the
 *  user's repository on the next write. */
export async function setItemWorkflow(itemId: string, workflow: string, branch?: string): Promise<void> {
  const path = `${ITEM_STORE_PREFIX}${itemId}/${STORE_MANIFEST}`;
  const ctx = branch ? { branch } : undefined;
  // THE SAME ctx AS THE WRITE. Reading without the branch reads a different
  // file: under the Supervisor an item created on a branch exists only in that
  // branch's data clone, so the unbranched read could not even find the store,
  // threw `Unknown spec store "item-<id>"` — not ENOENT, so the "never bound
  // yet" path below never ran — and creating an app under BMAD died one step
  // after writing its first artifact, leaving it created and unbound. Merging
  // base's copy into a branch write would have been just as wrong, quietly.
  //
  // An item that has never been bound has no manifest. That absence is the ONLY
  // condition defaulted here — any other failure (permissions, a corrupt file)
  // propagates, because starting from `{}` would rewrite the file from scratch
  // and drop everything it held.
  const raw = await specfs.readFile(path, ctx).catch((err: NodeJS.ErrnoException) => {
    if (err?.code === "ENOENT") return "{}";
    throw err;
  });
  const manifest = { ...(JSON.parse(raw) as Record<string, unknown>), workflow };
  await specfs.writeFile(path, JSON.stringify(manifest, null, 2) + "\n", ctx);
}
