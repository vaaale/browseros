import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { getConversationActiveFeatureBranch } from "@/lib/agent/conversations-server";

// Feature scope for SpecFS (027-vfs-specfs). The active feature is PER
// CONVERSATION, not global (matching 020's conversation `activeFeatureBranch`).
// Because a VFS write (`vfs.writeText('Documents/Specs/…')`) is a generic call
// with no conversation argument, the current conversation/branch is carried in a
// request-scoped AsyncLocalStorage — the same pattern as logging/context.ts.
//
// Resolution order for the active user-spec branch:
//   1. An explicit `branch` on the scope (option (b): an app that selected or
//      created a branch, or a context-less app's chosen branch).
//   2. The `conversationId` on the scope → the conversation's activeFeatureBranch.
//   3. None → callers that write MUST fail (SpecFSNoContextError in SpecFS).

export interface FeatureScope {
  conversationId?: string;
  branch?: string;
}

const als = new AsyncLocalStorage<FeatureScope>();

/** Run `fn` with a feature scope bound (agent tool calls, VFS API requests). */
export function withFeatureScope<T>(scope: FeatureScope, fn: () => T): T {
  return als.run(scope, fn);
}

/** The raw scope bound to the current execution, if any. */
export function currentFeatureScope(): FeatureScope | undefined {
  return als.getStore();
}

/** Resolve the active user-spec feature branch for the current scope, or
 *  undefined when no feature is in context (SpecFS treats writes as an error). */
export async function getActiveBranch(): Promise<string | undefined> {
  const scope = als.getStore();
  if (scope?.branch && scope.branch.trim()) return scope.branch.trim();
  if (scope?.conversationId) {
    return getConversationActiveFeatureBranch(scope.conversationId);
  }
  return undefined;
}

// Headers a caller (an app's request via the SDK, or an agent proxy) uses to
// carry its feature scope to a generic VFS API request. An explicit branch wins
// over a conversation id (option (b): an app that selected/created a branch).
export const FEATURE_BRANCH_HEADER = "x-bos-feature-branch";
export const FEATURE_CONVERSATION_HEADER = "x-bos-conversation";

/** Build a feature scope from request headers (empty when neither is present). */
export function scopeFromHeaders(headers: Headers): FeatureScope {
  return {
    branch: headers.get(FEATURE_BRANCH_HEADER)?.trim() || undefined,
    conversationId: headers.get(FEATURE_CONVERSATION_HEADER)?.trim() || undefined,
  };
}
