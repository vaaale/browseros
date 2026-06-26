import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  CopilotRuntime,
  AnthropicAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
  type CopilotServiceAdapter,
} from "@copilotkit/runtime";
import { getProviderConfig } from "@/lib/agent/provider";
import { familyOf } from "@/lib/agent/provider-meta";
import { buildRuntimeOptions } from "@/lib/agent/runtime";
import { OpenAIChatAdapter } from "@/lib/agent/openai-chat-adapter";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function buildAdapter(origin: string): Promise<CopilotServiceAdapter> {
  const c = await getProviderConfig();
  if (familyOf(c.provider) === "anthropic") {
    return new AnthropicAdapter({
      anthropic: new Anthropic({ apiKey: c.apiKey || "MISSING", baseURL: c.baseUrl || undefined }),
      model: c.model,
      promptCaching: { enabled: true },
      maxInputTokens: c.maxInputTokens,
    });
  }
  // OpenAI-family chat is routed through the BOS normalization proxy (forces
  // chat-completions, surfaces reasoning tokens, keeps the real key server-side).
  return new OpenAIChatAdapter({
    openai: new OpenAI({ apiKey: "proxied", baseURL: `${origin}/api/llm/openai` }),
    model: c.model,
    maxInputTokens: c.maxInputTokens,
  });
}

export async function POST(req: NextRequest) {
  // Provider config and MCP servers are resolved per request so changes made in
  // Settings take effect without a restart.
  const origin = new URL(req.url).origin;
  const runtime = new CopilotRuntime(await buildRuntimeOptions());
  const serviceAdapter = await buildAdapter(origin);
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter,
    endpoint: "/api/copilotkit",
  });
  return handleRequest(req);
}
