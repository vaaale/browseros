// Creating a feature branch and making it the active one.
//
// ONE implementation, because there are now two places a branch can be created
// from — the assistant's branch selector, and Build Studio's tree, where an edit
// to a repository elicits a branch instead of refusing without one — and they
// must agree on both halves. The pair is not optional: creating the branch
// without recording it leaves the user looking at a dropdown that has not
// changed, and recording a name that was never created leaves a branch nothing
// can mount.
//
// The branch is created in BOS's own repo. A COUPLED repo (a spec store, the
// user's marketplace, a registered repository) gets the same branch name when
// the Supervisor mounts it — `git worktree add -b <branch>` off that repo's own
// primary branch — which is why nothing here has to know about them. That is
// also why there is no way, and no need, to "create a branch in police-mcp"
// by hand: naming it here is what causes it to exist there.

import { setConversationActiveFeatureBranch } from "./conversations";

export interface CreatedFeatureBranch {
  branch: string;
}

/**
 * Create `bos/<kebab-name>` from a user-supplied name and make it the active
 * branch of `conversationId`, when there is one.
 *
 * Throws with the server's own message on failure — it names what was wrong
 * with the name, which is the part a caller cannot reconstruct.
 */
export async function createAndActivateFeatureBranch(
  name: string,
  conversationId?: string,
  /** What the branch is FOR, which decides which repositories get it. Omitted ⇒
   *  BOS's own repos only (user-specs + user-apps) and never one of the user's
   *  registered repositories — see coupled-repos.mjs. */
  scope?: { scope: "bos-core" | "marketplace-item" | "repository"; scopeId?: string },
): Promise<CreatedFeatureBranch> {
  const res = await fetch("/api/assistant/feature-branches", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ...(scope ?? {}) }),
  });
  const created = (await res.json()) as { ok?: boolean; branch?: unknown; error?: unknown };
  if (!created.ok || typeof created.branch !== "string") {
    throw new Error(typeof created.error === "string" ? created.error : "Could not create the feature branch.");
  }
  // Recorded only when there IS a conversation. Build Studio's tree can act
  // before its chat pane has one, and refusing there would reintroduce exactly
  // the dead end this function exists to remove — the caller still gets the
  // branch back and can use it for the write it was about to make.
  if (conversationId) await setConversationActiveFeatureBranch(conversationId, created.branch);
  return { branch: created.branch };
}
