import "server-only";
import { CopilotRuntime } from "@copilotkit/runtime";
import { listMcpServers } from "@/lib/mcp/store";
import { createBosMcpClient } from "@/lib/mcp/client";

type RuntimeOptions = ConstructorParameters<typeof CopilotRuntime>[0];

// Centralized CopilotRuntime options. Connects the agent to configured MCP
// servers; their tools are auto-exposed to the agent by CopilotKit.
export async function buildRuntimeOptions(): Promise<RuntimeOptions> {
  const servers = await listMcpServers();
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
