import "server-only";
import * as vfs from "@/os/vfs";

// Server-only counterpart to the "use client" conversations store. Developer
// (claude) delegations target a `bos/<kebab-name>` feature branch; the branch is
// resolved either from an explicit caller value or from the originating
// Assistant conversation's persisted `activeFeatureBranch`. Conversation files
// live in the user's VFS at /Documents/Chats/<id>.json.

const CHATS_DIR = "/Documents/Chats";
const FEATURE_BRANCH_RE = /^bos\/[a-z0-9]+(?:[-/][a-z0-9]+)*$/;

/** Validate a developer feature branch name, returning the trimmed value.
 *  Throws if it is not a `bos/<kebab-name>` branch — the delegate route surfaces
 *  the message as a 400 so the caller can correct it. */
export function validateFeatureBranch(branch: string): string {
  const trimmed = branch.trim();
  if (!FEATURE_BRANCH_RE.test(trimmed)) {
    throw new Error(
      `Invalid feature branch "${branch}": expected a lowercase kebab-case name like "bos/my-change".`,
    );
  }
  return trimmed;
}

/** Read the active feature branch persisted on a conversation, or undefined when
 *  there is no conversation, no file, or no branch set. */
export async function getConversationActiveFeatureBranch(
  conversationId?: string,
): Promise<string | undefined> {
  const id = conversationId?.trim();
  if (!id) return undefined;
  try {
    const content = await vfs.readText(`${CHATS_DIR}/${id}.json`);
    const parsed = JSON.parse(content) as { activeFeatureBranch?: unknown };
    const branch = parsed?.activeFeatureBranch;
    if (typeof branch !== "string" || !branch.trim()) return undefined;
    return validateFeatureBranch(branch);
  } catch {
    return undefined;
  }
}
