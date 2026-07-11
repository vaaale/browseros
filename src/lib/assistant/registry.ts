import "server-only";
import type { AssistantTool } from "./tools";
import { FRONTEND_TOOL_DECLARATIONS } from "./tools/frontend-declarations";
import { webSearchTools } from "./tools/server/web-search";
import { memoryTools } from "./tools/server/memory";
import { skillsTools } from "./tools/server/skills";
import { docsTools } from "./tools/server/docs";
import { gitTools } from "./tools/server/git";
import { runCommandTools } from "./tools/server/run-command";
import { configTools } from "./tools/server/config";
import { mcpTools } from "./tools/server/mcp";
import { workflowTools } from "./tools/server/workflows";
import { subAgentTools } from "./tools/server/subagents";
import { agentAdminTools } from "./tools/server/agent-admin";
import { selfImproveTools } from "./tools/server/self-improve";
import { devSourceTools } from "./tools/server/dev-source";
import { specTools } from "./tools/server/specs";
import { scratchpadTools } from "./tools/server/scratchpad";
import { integrationTools } from "./tools/server/integrations";
import { a2uiRenderTools } from "./tools/server/a2ui-render";
import { discoveryTools } from "./tools/server/discovery";

// The assistant tool registry (Milestone C). Server tools call their lib
// functions in-process; frontend tools are declared here (single source of
// truth the model is offered) and executed in the browser by the run client
// (handlers in src/components/agent/v2/FrontendToolsV2.tsx). Gating (016
// allowlist + 025 deferred (per-agent only — see gate.ts) + Settings overrides)
// is applied per step by the loop from this map — see agent-loop.ts / gate.ts.
//
// find_tools/find_agent are always-available discovery tools and take a lookup
// into the assembled map so they can report a deferred capability's live schema.

let cache: Record<string, AssistantTool> | undefined;

function frontendTools(): Record<string, AssistantTool> {
  const out: Record<string, AssistantTool> = {};
  for (const d of FRONTEND_TOOL_DECLARATIONS) {
    out[d.name] = { ...d, execution: "frontend" };
  }
  return out;
}

export function assistantTools(): Record<string, AssistantTool> {
  if (cache) return cache;
  const combined: Record<string, AssistantTool> = {
    ...frontendTools(),
    ...webSearchTools(),
    ...memoryTools(),
    ...skillsTools(),
    ...docsTools(),
    ...gitTools(),
    ...runCommandTools(),
    ...configTools(),
    ...mcpTools(),
    ...workflowTools(),
    ...subAgentTools(),
    ...agentAdminTools(),
    ...selfImproveTools(),
    ...devSourceTools(),
    ...specTools(),
    ...scratchpadTools(),
    ...integrationTools(),
    ...a2uiRenderTools(),
  };
  cache = { ...combined, ...discoveryTools((id) => combined[id]) };
  return cache;
}

// gateFor lives in ./gate to avoid a cycle (discovery imports it).
export { gateFor } from "./gate";
