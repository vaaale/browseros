import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { getAgent } from "@/lib/agent/subagents/store";
import { delegateToAgent } from "./delegate-common";

// Fixed-target Developer delegation (025-agent-delegation-v2), replacing the
// old per-run `makeDelegateTool` factory (subagents/runner.ts, closed over
// onEvent/depth/featureBranch). Shares delegate-common.ts's branching with
// agent_delegate — the seeded "developer" agent is `type: "claude"`
// (development is always done by Claude), so this still routes through
// runSubAgent/runClaudeAgent, just with the target and depth guard fixed.
//
// Naming note (not a rename): code comments/docstrings elsewhere refer to
// this as "the delegate_to_developer tool," but the ACTUAL registered id —
// already referenced by every seeded skill/AGENT.md — is `dev_delegate`
// (subagents/tools.ts's `DELEGATE_TO_DEVELOPER = "dev_delegate"` constant,
// e.g. seed/agents/build-studio/AGENT.md, data/skills/bos-app/SKILL.md).
export function devDelegateTools(): Record<string, AssistantTool> {
  return {
    dev_delegate: serverTool(
      "dev_delegate",
      "Delegate an implementation/coding task to the Developer (Claude) sub-agent, which edits BOS source on a feature branch. Use this for `implement` — never write source yourself. Provide a complete task including the relevant spec/plan/tasks context and acceptance criteria.",
      schema({ task: p.str("Full implementation task with context and acceptance criteria.") }, ["task"]),
      async (input, ctx) => {
        const task = String(input.task ?? "");
        if (!task) return "Error: dev_delegate: task is required.";

        const dev = await getAgent("developer");
        if (!dev) return "Error: dev_delegate: no 'developer' sub-agent is available to implement this.";

        return delegateToAgent(dev, false, task, ctx, false, "dev_delegate");
      },
    ),
  };
}
