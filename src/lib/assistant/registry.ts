import "server-only";
import type { AssistantTool } from "./tools";
import { serviceToolBridge } from "@/lib/agent/service-tool-bridge";
import { FRONTEND_TOOL_DECLARATIONS, PARALLEL_SAFE_FRONTEND_TOOLS } from "./tools/frontend-declarations";
import { webSearchTools } from "./tools/server/web-search";
import { fileToMarkdownTools } from "./tools/server/file-to-markdown";
import { viewImageTools } from "./tools/server/view-image";
import { videoTools } from "./tools/server/video-tools";
import { memoryTools } from "./tools/server/memory";
import { skillsTools } from "./tools/server/skills";
import { fileTools } from "./tools/server/files";
import { itemSpecTools } from "./tools/server/specs";
import { gitTools } from "./tools/server/git";
import { gitRemotesTools } from "./tools/server/git-remotes";
import { gitPushTools } from "./tools/server/git-push";
import { gitFetchTools } from "./tools/server/git-fetch";
import { gitMergeTools } from "./tools/server/git-merge";
import { gitMountTools } from "./tools/server/git-mounts";
import { runCommandTools } from "./tools/server/run-command";
import { configTools } from "./tools/server/config";
import { mcpTools } from "./tools/server/mcp";
import { subAgentTools } from "./tools/server/subagents";
import { devDelegateTools } from "./tools/server/dev-delegate";
import { schedulerTools } from "./tools/server/scheduler";
import { agentAdminTools } from "./tools/server/agent-admin";
import { selfImproveTools } from "./tools/server/self-improve";
import { devSourceTools } from "./tools/server/dev-source";
import { scratchpadTools } from "./tools/server/scratchpad";
import { integrationTools } from "./tools/server/integrations";
import { eventsTools } from "./tools/server/events";
import { discoveryTools } from "./tools/server/discovery";
import { claudeCodeTools } from "./tools/server/claude-code-tools";
import { conversationReviewTools } from "./tools/server/conversation-review";
import { conflictResolveTools } from "./tools/server/conflict-resolve";

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
// 039-service-tool-exposure: the bridge's `version` bumps on every
// register/unregister — comparing it against the version the cache was built
// from re-arms the cache the moment a service tool's lifecycle changes,
// without the bridge needing to import back into this module (R6).
let cacheServiceToolsVersion = -1;

function frontendTools(): Record<string, AssistantTool> {
  const out: Record<string, AssistantTool> = {};
  for (const d of FRONTEND_TOOL_DECLARATIONS) {
    out[d.name] = {
      ...d,
      execution: "frontend",
      ...(PARALLEL_SAFE_FRONTEND_TOOLS.has(d.name) ? { parallelSafe: true as const } : {}),
    };
  }
  return out;
}

/** Service-declared tools (039-service-tool-exposure), surfaced as native
 *  `AssistantTool` entries with `execution: "server"`. Each `execute` simply
 *  hands off to the bridge, which validates args against the tool's declared
 *  schema and dispatches to the owning service. */
function serviceAssistantTools(): Record<string, AssistantTool> {
  const out: Record<string, AssistantTool> = {};
  for (const tool of serviceToolBridge().registry.values()) {
    const { serviceId, declaration } = tool;
    out[declaration.name] = {
      name: declaration.name,
      description: declaration.description,
      parameters: declaration.inputSchema,
      execution: "server",
      // A service opts a tool into concurrent execution by declaring
      // `parallelSafe` (serviceToolTypes.ts). Absent = sequential, so every
      // service written before this existed keeps its exact prior behavior.
      // The IPC layer already correlates concurrent invocations by callId; the
      // flag is the service's assertion about its own handler.
      ...(declaration.parallelSafe === true ? { parallelSafe: true as const } : {}),
      // 039-service-tool-exposure T033: forward the per-call abort signal so
      // a run-abort/idle-timeout (runServerTool's `callAbort`) cancels the
      // pending worker-IPC waiter instead of leaking it (R10).
      execute: (input, ctx) => serviceToolBridge().invoke(serviceId, declaration.name, input, ctx.signal),
    };
  }
  return out;
}

export function assistantTools(): Record<string, AssistantTool> {
  const bridgeVersion = serviceToolBridge().version;
  if (cache && cacheServiceToolsVersion === bridgeVersion) return cache;
  const combined: Record<string, AssistantTool> = {
    // Spread first so a service tool can never shadow a built-in of the same
    // name — built-ins below always win a name collision.
    ...serviceAssistantTools(),
    ...frontendTools(),
    ...webSearchTools(),
    ...fileToMarkdownTools(),
    ...viewImageTools(),
    ...videoTools(),
    ...memoryTools(),
    ...skillsTools(),
    ...fileTools(),
    ...itemSpecTools(),
    ...gitTools(),
    ...gitRemotesTools(),
    ...gitPushTools(),
    ...gitFetchTools(),
    ...gitMergeTools(),
    ...gitMountTools(),
    ...runCommandTools(),
    ...configTools(),
    ...mcpTools(),
    ...subAgentTools(),
    ...claudeCodeTools(),
    ...devDelegateTools(),
    ...agentAdminTools(),
    ...selfImproveTools(),
    ...devSourceTools(),
    ...scratchpadTools(),
    ...integrationTools(),
    ...eventsTools(),
    ...schedulerTools(),
    ...conversationReviewTools(),
    ...conflictResolveTools(),
  };
  cache = { ...combined, ...discoveryTools((id) => combined[id]) };
  cacheServiceToolsVersion = bridgeVersion;
  return cache;
}

// gateFor lives in ./gate to avoid a cycle (discovery imports it).
export { gateFor } from "./gate";
