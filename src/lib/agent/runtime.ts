import "server-only";
import { CopilotRuntime } from "@copilotkit/runtime";
import { listMcpServers } from "@/lib/mcp/store";
import { createBosMcpClient } from "@/lib/mcp/client";
import { getBrowserAutomationServer } from "@/lib/automation/playwright-mcp";
import { getActiveAgentId, getSubAgent } from "@/lib/agent/subagents/store";

type RuntimeOptions = ConstructorParameters<typeof CopilotRuntime>[0];

// Centralized CopilotRuntime options. Connects the agent to configured MCP
// servers (plus the managed browser-automation server when enabled); their tools
// are auto-exposed to the agent by CopilotKit. Configured servers are filtered to
// the active agent's allowed MCP set (011-per-agent-capabilities; unset = all).
// Pass an agentId to scope for an embed's pinned agent (012); defaults to active.
export async function buildRuntimeOptions(agentId?: string): Promise<RuntimeOptions> {
  const agent = await getSubAgent(agentId ?? (await getActiveAgentId()));
  const mcpAllow = agent?.mcp;
  const configuredAll = await listMcpServers();
  const configured =
    !mcpAllow || mcpAllow.length === 0
      ? configuredAll
      : configuredAll.filter((s) => mcpAllow.includes(s.name) || mcpAllow.includes(s.endpoint));
  const automation = await getBrowserAutomationServer();
  const servers = automation ? [...configured, automation] : configured;
  if (servers.length === 0) return {};

  return {
    mcpServers: servers.map((s) => ({ endpoint: s.endpoint, apiKey: s.apiKey })),
    createMCPClient: async (config) => {
      const match = servers.find((s) => s.endpoint === config.endpoint);
      return createBosMcpClient(
        match ?? { name: config.endpoint, endpoint: config.endpoint, apiKey: config.apiKey },
      );
    },
  };
}
