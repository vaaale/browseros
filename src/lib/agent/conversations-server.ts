import "server-only";
import * as vfs from "@/os/vfs";
import { isValidFeatureBranch } from "@/lib/agent/feature-branch";

// Server-only counterpart to the "use client" conversations store. Developer
// (claude) delegations target a `bos/<kebab-name>` feature branch; the branch is
// resolved either from an explicit caller value or from the originating
// Assistant conversation's persisted `activeFeatureBranch`. Conversation files
// live in the user's VFS at /Documents/Chats/<id>.json.

const CHATS_DIR = "/Documents/Chats";

/** Validate a developer feature branch name, returning the trimmed value.
 *  Throws if it is not a `bos/<kebab-name>` branch — the delegate route surfaces
 *  the message as a 400 so the caller can correct it. */
export function validateFeatureBranch(branch: string): string {
  const trimmed = branch.trim();
  if (!isValidFeatureBranch(trimmed)) {
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

/** Read the conflict-resolution session id persisted on a conversation
 *  (035-spec-promote-conflict-escalation), or undefined when there is none.
 *
 *  Mirrors `getConversationActiveFeatureBranch` exactly, and for the same
 *  reason: `ToolContext` exposes only `conversationId` (a string), never a
 *  conversation object, so a server tool that needs conversation-scoped
 *  context has to read it back off the persisted file. The escalation writes
 *  `conflictSessionId` as a top-level field alongside `activeFeatureBranch`;
 *  `saveConversationMessages` preserves top-level fields, so it survives the
 *  park→rewake boundary (a new run on the same conversation). */
export async function getConversationConflictSessionId(
  conversationId?: string,
): Promise<string | undefined> {
  const id = conversationId?.trim();
  if (!id) return undefined;
  try {
    const content = await vfs.readText(`${CHATS_DIR}/${id}.json`);
    const parsed = JSON.parse(content) as { conflictSessionId?: unknown };
    const sessionId = parsed?.conflictSessionId;
    if (typeof sessionId !== "string" || !sessionId.trim()) return undefined;
    return sessionId.trim();
  } catch {
    return undefined;
  }
}

/** Every distinct `activeFeatureBranch` currently DECLARED across all
 *  conversations, regardless of whether a real git branch exists for it yet.
 *  Under the Supervisor, `dev_branch_request` only records the name on the
 *  originating conversation — the actual branch + worktree aren't created
 *  until `dev_delegate` first runs under it (provisioned lazily, at delegate
 *  time). Until then, `system/git.ts`'s `listFeatureBranches()` (real git
 *  refs only) can't see it, so a DIFFERENT conversation has no way to select
 *  the same branch someone just set up elsewhere. Merged into the feature
 *  branch dropdown's options alongside the real ones so it's selectable
 *  immediately; selecting it here is harmless (just another conversation's
 *  JSON field) regardless of whether the branch has materialized yet. */
export async function listDeclaredFeatureBranches(): Promise<string[]> {
  const branches = new Set<string>();
  const entries = await vfs.list(CHATS_DIR).catch(() => []);
  for (const entry of entries) {
    if (entry.type !== "file" || !entry.name.endsWith(".json")) continue;
    try {
      const raw = await vfs.readText(`${CHATS_DIR}/${entry.name}`);
      const parsed = JSON.parse(raw) as { activeFeatureBranch?: unknown };
      if (typeof parsed.activeFeatureBranch === "string" && isValidFeatureBranch(parsed.activeFeatureBranch.trim())) {
        branches.add(parsed.activeFeatureBranch.trim());
      }
    } catch {
      // Corrupt/unreadable conversation file — skip it, not fatal to the listing.
    }
  }
  return Array.from(branches);
}
