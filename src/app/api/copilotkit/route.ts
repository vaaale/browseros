import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  CopilotRuntime,
  AnthropicAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
  type CopilotServiceAdapter,
} from "@copilotkit/runtime";
import { BuiltInAgent } from "@copilotkit/runtime/v2";
import { getProviderConfig } from "@/lib/agent/provider";
import { familyOf } from "@/lib/agent/provider-meta";
import { buildRuntimeOptions } from "@/lib/agent/runtime";
import { OpenAIChatAdapter } from "@/lib/agent/openai-chat-adapter";
import { composeInstructions } from "@/lib/agent/instructions";

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
  // Provider config (and the managed browser-automation server) are resolved per
  // request so Settings changes take effect without a restart. User-configured MCP
  // servers are NOT injected here — the agent uses them via the gateway (014).
  const url = new URL(req.url);
  const origin = url.origin;
  // The agent is per-conversation and MUST be pinned on the request (the client
  // sends ?agent=<conversation's agent>). There is no global active-agent
  // fallback — a missing pin is a bug, so fail loudly rather than composing the
  // wrong personality.
  const agentId = url.searchParams.get("agent") || "";
  if (!agentId) {
    return new Response("Missing required ?agent= (the conversation's agent id).", { status: 400 });
  }
  const [runtimeOptions, serviceAdapter, prompt] = await Promise.all([
    buildRuntimeOptions(),
    buildAdapter(origin),
    composeInstructions(agentId),
  ]);
  // CopilotKit 1.61's v2 path auto-creates the default agent from the service
  // adapter's language model as `new BuiltInAgent({ model })` — with NO prompt —
  // and the client's `instructions` prop is never forwarded to it, so the composed
  // system prompt (core policy + personality + memory + skills) is silently
  // dropped. Construct the default agent ourselves WITH the composed prompt so it
  // actually reaches the model. Runtime-level MCP/action tools are still assigned
  // to this agent by CopilotRuntime. Falls back to the auto-created agent if the
  // adapter can't expose a language model.
  const model = serviceAdapter.getLanguageModel?.();
  const runtime = new CopilotRuntime({
    ...runtimeOptions,
    ...(model ? { agents: { default: new BuiltInAgent({ model, prompt }) } } : {}),
  });
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter,
    endpoint: "/api/copilotkit",
  });
  return handleRequest(req);
}
