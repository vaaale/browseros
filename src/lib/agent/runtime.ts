import "server-only";
import { CopilotRuntime } from "@copilotkit/runtime";
import { createBosMcpClient } from "@/lib/mcp/client";
import { getBrowserAutomationServer } from "@/lib/automation/playwright-mcp";

type RuntimeOptions = ConstructorParameters<typeof CopilotRuntime>[0];

// Centralized CopilotRuntime options.
//
// User-configured MCP servers are NOT injected here. The agent uses them through
// the MCP tool gateway (014-mcp-tool-gateway) — searching/listing tools and calling
// them on demand — so a server with 100 tools never bloats the request. The only
// server injected directly into the runtime is the managed browser-automation
// server (a small, curated tool set with its own consent/safety model,
// 004-browser-automation), and only when it is enabled.
//
// `actions: []` is REQUIRED: CopilotKit 1.61 only fetches MCP tools inside an
// `if (this.params.actions)` branch (handleServiceAdapter → getToolsFromMCP), so
// without it the automation tools would never reach the model. An empty array
// (still truthy) flips that branch on without adding any server-side actions.
export async function buildRuntimeOptions(): Promise<RuntimeOptions> {
  const automation = await getBrowserAutomationServer();
  if (!automation) return {};
  const key = automation.endpoint || `stdio://${automation.name}`;
  return {
    actions: [],
    mcpServers: [{ endpoint: key, apiKey: automation.apiKey }],
    createMCPClient: async (config) =>
      createBosMcpClient(
        config.endpoint === key ? automation : { name: config.endpoint, endpoint: config.endpoint, apiKey: config.apiKey },
      ),
  };
}
