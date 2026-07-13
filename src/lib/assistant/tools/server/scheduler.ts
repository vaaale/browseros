import "server-only";
import type { AssistantTool } from "../../tools";
import { adaptLlmTools } from "./adapt";
import { SCHEDULER_TOOLS } from "@/lib/scheduler/agent-tools";

// Scheduler tools, ported into v2's registry (025-agent-delegation-v2, Phase
// 4). These existed ONLY in the legacy sub-agent engine before this migration
// — genuinely absent from assistantTools() — so the primary/active
// personality had no scheduler access at all. Registering them here makes
// them EXIST in the registry; it does not by itself grant them to any
// agent — that's a separate, deliberate seeded-allowlist decision (see the
// migration audit, plan.md/tasks.md Phase 4).
export function schedulerTools(): Record<string, AssistantTool> {
  return adaptLlmTools(SCHEDULER_TOOLS, Object.keys(SCHEDULER_TOOLS));
}
