import { NextRequest } from "next/server";
import {
  CopilotRuntime,
  AnthropicAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import { AGENT_MODEL } from "@/lib/agent/config";
import { buildRuntimeOptions } from "@/lib/agent/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const serviceAdapter = new AnthropicAdapter({
  model: AGENT_MODEL,
  promptCaching: { enabled: true },
});

export async function POST(req: NextRequest) {
  // Runtime options (incl. MCP servers) are resolved per request so newly
  // configured MCP servers are picked up without a restart.
  const runtime = new CopilotRuntime(await buildRuntimeOptions());
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter,
    endpoint: "/api/copilotkit",
  });
  return handleRequest(req);
}
