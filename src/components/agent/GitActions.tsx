"use client";

import { useCopilotAction } from "@copilotkit/react-core";
import { useActiveConversation } from "@/lib/agent/conversations";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";
import { fetchToolJson, runToolHandler } from "@/lib/agent/tool-kernel";

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
    handler: () =>
      runToolHandler("dev_git_status", async ({ signal }) => {
        const query = activeConversation?.activeFeatureBranch
          ? `?branch=${encodeURIComponent(activeConversation.activeFeatureBranch)}`
          : "";
        const out = await fetchToolJson("dev_git_status", `/api/system/git${query}`, { signal });
        if (!out.ok) return out.error;
        const res = out.data as { error?: string };
        return res.error ? `Error: ${res.error}` : JSON.stringify(out.data);
      }),
  });

  return null;
}
