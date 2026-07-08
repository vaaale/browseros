"use client";

import { useCopilotAction } from "@copilotkit/react-core";
import { useActiveConversation } from "@/lib/agent/conversations";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";

// Read-only git status for the assistant. Self-modification is owned by the
// Supervisor: the developer sub-agent edits an ISOLATED preview worktree and the
// Supervisor commits + previews/promotes it — the assistant never branches or
// stages the live checkout (doing so would break the running base and block
// promote; see specs/005, 017). The old in-place startFeatureBranch/stageChanges
// actions were removed for that reason.
export function GitActions({ agentId = DEFAULT_AGENT_ID }: { agentId?: string }) {
  const activeConversation = useActiveConversation(agentId);

  useCopilotAction({
    name: "dev_git_status",
    description:
      "Show git status of the BOS repo: the main checkout's branch + changed files, AND any pending self-modification `candidate` (a built-but-not-yet-active version living in an isolated worktree). If `candidate` is present, a delegated edit lives THERE (committed) — the main checkout will look clean, so do NOT re-apply the change in place; the user previews/promotes the candidate from the top-bar Active ▾ menu.",
    parameters: [],
    handler: async () => {
      const query = activeConversation?.activeFeatureBranch
        ? `?branch=${encodeURIComponent(activeConversation.activeFeatureBranch)}`
        : "";
      const res = await fetch(`/api/system/git${query}`).then((r) => r.json());
      return res.error ? `Error: ${res.error}` : JSON.stringify(res);
    },
  });

  return null;
}
