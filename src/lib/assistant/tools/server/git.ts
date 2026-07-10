import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema } from "./util";
import { status } from "@/lib/system/git";
import { supervisorNextChanges } from "@/lib/devharness/supervisor";
import { getConversationActiveFeatureBranch } from "@/lib/agent/conversations-server";

// Read-only git status, ported from GitActions.tsx. Self-modification is owned
// by the Supervisor (see specs/005, 017) — the assistant never branches or
// stages the live checkout, so dev_git_status is the only git tool here.

export function gitTools(): Record<string, AssistantTool> {
  return {
    dev_git_status: serverTool(
      "dev_git_status",
      "Show git status of the BOS repo: the main checkout's branch + changed files, AND any pending self-modification `candidate` (a built-but-not-yet-active version living in an isolated worktree). If `candidate` is present, a delegated edit lives THERE (committed) — the main checkout will look clean, so do NOT re-apply the change in place; the user previews/promotes the candidate from the top-bar Active ▾ menu.",
      schema(),
      async (_input, ctx) => {
        const base = await status();
        const branch = await getConversationActiveFeatureBranch(ctx.conversationId).catch(() => undefined);
        const sup = (await supervisorNextChanges(branch).catch(() => null)) as
          | { ok?: boolean; candidate?: unknown }
          | null;
        const candidate = sup && sup.ok && sup.candidate ? sup.candidate : null;
        return JSON.stringify({ ...base, candidate });
      },
    ),
  };
}
