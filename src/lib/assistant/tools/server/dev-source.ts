import "server-only";
import type { AssistantTool } from "../../tools";
import { adaptLlmTools } from "./adapt";
import { DEV_TOOLS } from "@/lib/agent/subagents/tools";

// Read-only BOS source inspection (ported from DevActions.tsx). These are the
// SAME repo-jailed implementations delegated dev agents use (src/lib/agent/
// subagents/tools.ts DEV_TOOLS), adapted to v2. dev_git_status is provided by
// the git module; write/branch ops are intentionally NOT here (source changes
// go through the Developer sub-agent on a feature branch).
export function devSourceTools(): Record<string, AssistantTool> {
  return adaptLlmTools(DEV_TOOLS, ["bos_source_list", "bos_source_read", "bos_source_search"]);
}
