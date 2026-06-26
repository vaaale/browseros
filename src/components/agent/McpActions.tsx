"use client";

import { useCopilotAction } from "@copilotkit/react-core";

// Lets the agent inspect and manage its own MCP server connections.
export function McpActions() {
  useCopilotAction({
    name: "listMcpServers",
    description: "List the MCP servers the agent is connected to.",
    parameters: [],
    handler: async () => {
      const res = await fetch("/api/mcp").then((r) => r.json());
      return JSON.stringify(res.servers ?? []);
    },
  });

  useCopilotAction({
    name: "addMcpServer",
    description:
      "Connect a new MCP server by endpoint URL (streamable-http by default). Its tools become available to the agent on the next message.",
    parameters: [
      { name: "endpoint", type: "string", description: "MCP server URL", required: true },
      { name: "name", type: "string", description: "Friendly name", required: false },
      { name: "apiKey", type: "string", description: "Bearer token if required", required: false },
      { name: "transport", type: "string", description: '"http" (default) or "sse"', required: false },
    ],
    handler: async ({ endpoint, name, apiKey, transport }) => {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint, name, apiKey, transport }),
      }).then((r) => r.json());
      return res.error ? `Error: ${res.error}` : `Connected. Servers: ${JSON.stringify(res.servers)}`;
    },
  });

  useCopilotAction({
    name: "removeMcpServer",
    description: "Disconnect an MCP server by endpoint URL.",
    parameters: [{ name: "endpoint", type: "string", description: "MCP server URL", required: true }],
    handler: async ({ endpoint }) => {
      const res = await fetch(`/api/mcp?endpoint=${encodeURIComponent(endpoint as string)}`, {
        method: "DELETE",
      }).then((r) => r.json());
      return `Remaining servers: ${JSON.stringify(res.servers ?? [])}`;
    },
  });

  useCopilotAction({
    name: "probeMcpServer",
    description: "Test connectivity to an MCP server and list its tools.",
    parameters: [{ name: "endpoint", type: "string", description: "MCP server URL", required: true }],
    handler: async ({ endpoint }) => {
      const res = await fetch(`/api/mcp?probe=${encodeURIComponent(endpoint as string)}`).then((r) => r.json());
      return JSON.stringify(res.result ?? {});
    },
  });

  return null;
}
