import "server-only";
import type { AssistantTool } from "../../tools";
import { SPEC_TOOLS, makeSpecTools } from "@/lib/agent/subagents/tools";
import { getConversationActiveFeatureBranch } from "@/lib/agent/conversations-server";

// Spec-authoring tools (ported from SpecActions.tsx) — the SAME server
// implementations Build Studio's delegated agents use (makeSpecTools). Each
// call resolves the conversation's active feature branch server-side and binds
// the spec store to it (020), so specs land on the same branch the Developer
// builds. The static SPEC_TOOLS provide each op's description + schema.
const SPEC_IDS = Object.keys(SPEC_TOOLS);

export function specTools(): Record<string, AssistantTool> {
  const out: Record<string, AssistantTool> = {};
  for (const id of SPEC_IDS) {
    const base = SPEC_TOOLS[id];
    out[id] = {
      name: id,
      description: base.description ?? "",
      parameters: base.parameters,
      execution: "server",
      execute: async (input, ctx) => {
        try {
          const branch = await getConversationActiveFeatureBranch(ctx.conversationId).catch(() => undefined);
          const bound = makeSpecTools(branch)[id];
          const result = await bound.execute(input ?? {});
          return typeof result === "string" ? result : JSON.stringify(result);
        } catch (e) {
          return `Error: ${id}: ${(e as Error).message}`;
        }
      },
    };
  }
  return out;
}
