import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { DEFAULT_MAX_TOKENS, getProviderConfig, type ProviderConfig } from "@/lib/agent/provider";
import { familyOf, normalizeApiBase } from "@/lib/agent/provider-meta";
import type { StreamTurn, TurnResult, TurnToolCall } from "./agent-loop";
import type { ChatMessage } from "./messages";

// streamModelTurn — ONE streamed model turn over full conversation history,
// per provider family, with AbortSignal end-to-end. Extracted from llm.ts /
// openai-chat-adapter.ts, preserving their quirks:
//   - anthropic: max_tokens mandatory; prompt caching on the system block;
//   - openai chat: streaming accumulation (undici HPE workaround), non-standard
//     `reasoning_content` deltas (DeepSeek/Qwen), max_tokens vs
//     max_completion_tokens by provider, jinja "no user message" guard;
//   - openai-responses: Responses API item shapes (function_call /
//     function_call_output). Non-streamed for now — the text arrives as a
//     single delta; acceptable until a Responses streaming pass.
// Provider config is resolved per call so Settings changes apply immediately.

export const streamModelTurn: StreamTurn = async (opts) => {
  const c = await getProviderConfig();
  if (familyOf(c.provider) === "anthropic") return anthropicTurn(c, opts);
  if (c.provider === "openai-responses") return responsesTurn(c, opts);
  return openaiChatTurn(c, opts);
};

type TurnOpts = Parameters<StreamTurn>[0];

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ── Anthropic ────────────────────────────────────────────────────────────────

function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  const pushUser = (blocks: Anthropic.ContentBlockParam[]) => {
    const last = out[out.length - 1];
    if (last?.role === "user" && Array.isArray(last.content)) {
      (last.content as Anthropic.ContentBlockParam[]).push(...blocks);
    } else {
      out.push({ role: "user", content: blocks });
    }
  };
  for (const m of messages) {
    if (m.role === "user") {
      pushUser([{ type: "text", text: m.content ?? "" }]);
    } else if (m.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.content?.trim()) content.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) });
      }
      if (content.length) out.push({ role: "assistant", content });
    } else if (m.role === "tool" && m.toolCallId) {
      pushUser([{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content ?? "" }]);
    }
  }
  return out;
}

async function anthropicTurn(c: ProviderConfig, opts: TurnOpts): Promise<TurnResult> {
  const client = new Anthropic({ apiKey: c.apiKey || "MISSING", baseURL: c.baseUrl || undefined });
  const stream = await client.messages.create(
    {
      model: c.model,
      max_tokens: c.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
      messages: toAnthropicMessages(opts.messages),
      tools: opts.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool.InputSchema,
      })),
      stream: true,
    },
    { signal: opts.signal },
  );

  let text = "";
  const calls: TurnToolCall[] = [];
  // Index-addressed open blocks: text/thinking stream deltas, tool_use
  // accumulates partial JSON args.
  const openCalls = new Map<number, TurnToolCall>();
  for await (const ev of stream) {
    if (ev.type === "content_block_start") {
      if (ev.content_block.type === "tool_use") {
        const call: TurnToolCall = { id: ev.content_block.id, name: ev.content_block.name, arguments: "" };
        openCalls.set(ev.index, call);
        calls.push(call);
      }
    } else if (ev.type === "content_block_delta") {
      if (ev.delta.type === "text_delta") {
        text += ev.delta.text;
        opts.onDelta({ kind: "text", messageId: opts.messageId, delta: ev.delta.text });
      } else if (ev.delta.type === "input_json_delta") {
        const call = openCalls.get(ev.index);
        if (call) call.arguments += ev.delta.partial_json;
      } else if (ev.delta.type === "thinking_delta") {
        opts.onDelta({ kind: "reasoning", messageId: opts.messageId, delta: ev.delta.thinking });
      }
    }
  }
  return { text, toolCalls: calls };
}

// ── OpenAI Chat Completions (openai / openai-compatible / local) ────────────

function openaiTokenParam(c: ProviderConfig): Record<string, number> {
  if (!c.maxTokens || c.maxTokens <= 0) return {};
  const field = c.provider === "openai-compatible" ? "max_tokens" : "max_completion_tokens";
  return { [field]: c.maxTokens };
}

function toOpenAiMessages(system: string, messages: ChatMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content ?? "" });
    } else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content ?? "",
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.function.name, arguments: tc.function.arguments },
              })),
            }
          : {}),
      });
    } else if (m.role === "tool" && m.toolCallId) {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content ?? "" });
    }
  }
  // Jinja chat templates on some local servers require ≥1 user message.
  if (!out.some((m) => m.role === "user")) {
    const insertAt = out.findIndex((m) => m.role === "assistant");
    out.splice(insertAt >= 0 ? insertAt : out.length, 0, { role: "user", content: "." });
  }
  return out;
}

async function openaiChatTurn(c: ProviderConfig, opts: TurnOpts): Promise<TurnResult> {
  const client = new OpenAI({
    apiKey: c.apiKey || "local",
    baseURL: c.baseUrl ? normalizeApiBase(c.baseUrl) : undefined,
  });
  const stream = await client.chat.completions.create(
    {
      model: c.model,
      messages: toOpenAiMessages(opts.system, opts.messages),
      ...(opts.tools.length
        ? {
            tools: opts.tools.map((t) => ({
              type: "function" as const,
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
      stream: true,
      ...openaiTokenParam(c),
    },
    { signal: opts.signal },
  );

  let text = "";
  const byIndex = new Map<number, TurnToolCall>();
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta as
      | { content?: string | null; reasoning_content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }
      | undefined;
    if (!delta) continue;
    if (delta.content) {
      text += delta.content;
      opts.onDelta({ kind: "text", messageId: opts.messageId, delta: delta.content });
    }
    if (delta.reasoning_content) {
      opts.onDelta({ kind: "reasoning", messageId: opts.messageId, delta: delta.reasoning_content });
    }
    for (const tc of delta.tool_calls ?? []) {
      let call = byIndex.get(tc.index);
      if (!call) {
        call = { id: tc.id || `call-${opts.messageId}-${tc.index}`, name: "", arguments: "" };
        byIndex.set(tc.index, call);
      }
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.name += tc.function.name;
      if (tc.function?.arguments) call.arguments += tc.function.arguments;
    }
  }
  const toolCalls = [...byIndex.values()].filter((call) => call.name);
  return { text, toolCalls };
}

// ── OpenAI Responses API ─────────────────────────────────────────────────────

function toResponsesInput(messages: ChatMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      input.push({ role: "user", content: m.content ?? "" });
    } else if (m.role === "assistant") {
      if (m.content?.trim()) input.push({ role: "assistant", content: m.content });
      for (const tc of m.toolCalls ?? []) {
        input.push({ type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
      }
    } else if (m.role === "tool" && m.toolCallId) {
      input.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content ?? "" });
    }
  }
  return input;
}

async function responsesTurn(c: ProviderConfig, opts: TurnOpts): Promise<TurnResult> {
  const client = new OpenAI({
    apiKey: c.apiKey || "local",
    baseURL: c.baseUrl ? normalizeApiBase(c.baseUrl) : undefined,
  });
  const res = await (client.responses.create(
    {
      model: c.model,
      instructions: opts.system,
      input: toResponsesInput(opts.messages) as never,
      tools: opts.tools.map((t) => ({
        type: "function" as const,
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })) as never,
      ...(c.maxTokens && c.maxTokens > 0 ? { max_output_tokens: c.maxTokens } : {}),
    } as Parameters<typeof client.responses.create>[0],
    { signal: opts.signal },
  ) as unknown as Promise<Record<string, unknown>>);

  const output = ((res.output as unknown[]) ?? []).map((i) => i as Record<string, unknown>);
  const text = output
    .filter((item) => item.type === "message")
    .flatMap((msg) => (msg.content as unknown[]) ?? [])
    .filter((blk) => (blk as Record<string, unknown>).type === "output_text")
    .map((blk) => (blk as Record<string, unknown>).text as string)
    .join("");
  if (text) opts.onDelta({ kind: "text", messageId: opts.messageId, delta: text });
  const toolCalls: TurnToolCall[] = output
    .filter((item) => item.type === "function_call")
    .map((item) => ({
      id: (item.call_id as string) || (item.id as string) || `call-${opts.messageId}`,
      name: item.name as string,
      arguments: (item.arguments as string) || "{}",
    }));
  return { text, toolCalls };
}
