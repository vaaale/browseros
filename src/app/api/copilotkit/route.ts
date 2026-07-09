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
import { familyOf, normalizeApiBase } from "@/lib/agent/provider-meta";
import { buildRuntimeOptions } from "@/lib/agent/runtime";
import { OpenAIChatAdapter, OpenAIResponsesAdapter } from "@/lib/agent/openai-chat-adapter";
import { composeInstructions } from "@/lib/agent/instructions";
import { getConversationActiveFeatureBranch } from "@/lib/agent/conversations-server";
import { logger } from "@/lib/logging";
import { withCompaction } from "@/lib/agent/compaction/middleware";
import { withToolGate } from "@/lib/agent/tool-gate";
import { getAgent } from "@/lib/agent/subagents/store";
import { readMetadataOverrides } from "@/lib/agent/tool-metadata-overrides";

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
  if (c.provider === "openai-responses") {
    // Responses API: use the adapter that targets /responses (not /chat/completions).
    const baseURL = c.baseUrl ? normalizeApiBase(c.baseUrl) : undefined;
    return new OpenAIResponsesAdapter({
      openai: new OpenAI({ apiKey: c.apiKey || "local", baseURL }),
      model: c.model,
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
  // The agent is per-conversation and pinned on chat requests (the client sends
  // ?agent=<conversation's agent>). This endpoint is ALSO hit by CopilotKit's
  // agent-less discovery/runtime-info requests, so we don't reject a missing pin
  // here — we simply only build the personalized agent WHEN one is pinned.
  // (composeInstructions itself still throws on an empty id, so the actual
  // resolution point never silently falls back to the wrong agent.)
  const agentId = url.searchParams.get("agent") || "";
  const convId = url.searchParams.get("conv") || "";

  if (convId) {
    logger().log({
      level: "info",
      component: "assistant",
      conversation: convId,
      msg: "conversation turn",
      data: { agentId: agentId || undefined },
    });
  }

  const [runtimeOptions, serviceAdapter] = await Promise.all([
    buildRuntimeOptions(),
    buildAdapter(origin),
  ]);
  // CopilotKit 1.61's v2 path auto-creates the default agent from the service
  // adapter's language model as `new BuiltInAgent({ model })` — with NO prompt —
  // and the client's `instructions` prop is never forwarded to it, so the composed
  // system prompt (core policy + personality + memory + skills) is silently
  // dropped. When an agent is pinned, construct the default agent ourselves WITH
  // the composed prompt so it actually reaches the model. Runtime-level MCP/action
  // tools are still assigned to this agent by CopilotRuntime.
  const rawModel = agentId ? serviceAdapter.getLanguageModel?.() : undefined;
  // Apply compaction to the provider input, then wrap that model with the
  // server-side tool gate. The gate stays outermost so it derives revealed
  // deferred tools from the full transcript before compaction can remove old
  // tool results from what the provider sees.
  let model = rawModel && convId ? withCompaction(rawModel, convId) : rawModel;
  if (model && agentId) {
    const agent = await getAgent(agentId).catch(() => undefined);
    if (agent) {
      const descriptions = await readMetadataOverrides().catch(() => ({}));
      model = withToolGate(model, {
        allow: agent.tools ?? [],
        deferredTools: agent.deferredTools ?? [],
        descriptions: Object.fromEntries(
          Object.entries(descriptions).map(([id, o]) => [id, o?.description]),
        ),
      });
    }
  }
  let prompt = agentId ? await composeInstructions(agentId) : "";
  if (model && convId) {
    // Surface this conversation's active feature branch so the model delegates BOS
    // source changes directly instead of (blindly) calling dev_branch_request — it
    // has no other way to observe the branch the user selected in the UI.
    const branch = await getConversationActiveFeatureBranch(convId).catch(() => undefined);
    if (branch) {
      prompt += `\n\n## Active feature branch\nThis conversation already has an active feature branch \`${branch}\` for BrowserOS source changes. Do NOT call dev_branch_request — delegate the source change directly to the "developer" sub-agent.`;
    }
  }
  const agents = model ? { default: new BuiltInAgent({ model, prompt }) } : undefined;
  const runtime = new CopilotRuntime({
    ...runtimeOptions,
    ...(agents ? { agents } : {}),
  });
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter,
    endpoint: "/api/copilotkit",
  });
  return handleRequest(req);
}
