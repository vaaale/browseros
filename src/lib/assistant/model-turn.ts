import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { DEFAULT_MAX_TOKENS, getProviderConfig, type ProviderConfig } from "@/lib/agent/provider";
import { familyOf, normalizeApiBase } from "@/lib/agent/provider-meta";
import type { StreamTurn, TurnResult, TurnToolCall } from "./agent-loop";
import type { ChatMessage } from "./messages";
import { compactChatMessages } from "@/lib/agent/compaction/v2";

// streamModelTurn — ONE streamed model turn over full conversation history,
// per provider family, with AbortSignal end-to-end. Extracted from llm.ts /
// openai-chat-adapter.ts, preserving their quirks:
//   - anthropic: max_tokens mandatory; prompt caching on the system block;
//   - openai chat: streaming accumulation (undici HPE workaround), non-standard
//     `reasoning_content` deltas (DeepSeek/Qwen), max_tokens vs
//     max_completion_tokens by provider, jinja "no user message" guard;
//   - openai-responses: Responses API item shapes (function_call /
//     function_call_output). Streamed via SSE: output_text / reasoning_summary
//     deltas surface live, function_call arguments accumulate per output item.
// Provider config is resolved per call so Settings changes apply immediately.

export const streamModelTurn: StreamTurn = async (opts) => {
  const c = await getProviderConfig(opts.model);
  // Compaction (022) runs here — v2 feeds the provider directly, so it can't go
  // through the ai-sdk middleware. Applied to the transcript before provider
  // conversion; the compacted view is ephemeral (never persisted).
  const messages = await compactChatMessages(
    opts.conversationId,
    opts.system,
    opts.messages,
    c.maxTokens,
    c.maxInputTokens,
  ).catch(() => opts.messages);
  const turnOpts = { ...opts, messages };
  if (familyOf(c.provider) === "anthropic") return anthropicTurn(c, turnOpts);
  if (c.provider === "openai-responses") return responsesTurn(c, turnOpts);
  return openaiChatTurn(c, turnOpts);
};

type TurnOpts = Parameters<StreamTurn>[0];

// Some OpenAI-compatible local servers answer a STREAMING request that fails
// (e.g. context overflow) with HTTP 200 + a bare JSON error body served under a
// `text/event-stream` content-type — instead of a 4xx status or an SSE `error`/
// `response.failed` event. The SDK's SSE parser then yields zero events and the
// stream ends silently, producing an empty turn with no error surfaced.
//
// Peek the first byte of the body: a valid SSE stream starts with a field line
// (`event:` / `data:` / `:`) and never with `{`. If we instead see a JSON body
// carrying a top-level `error`, re-emit it as HTTP 400 so the SDK throws (the
// agent loop turns that into the error card). Anything else is replayed verbatim
// through a lazy stream so normal streaming is completely unaffected.
const errorAwareFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (!res.ok || !res.body) return res;
  const reader = res.body.getReader();
  const first = await reader.read();
  const value = first.value;
  if (value && value[0] === 0x7b /* '{' */) {
    const chunks: Uint8Array[] = [value];
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      if (r.value) chunks.push(r.value);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const text = buf.toString("utf8");
    try {
      const j = JSON.parse(text) as { error?: unknown };
      if (j && typeof j === "object" && j.error) {
        return new Response(text, { status: 400, statusText: "Bad Request", headers: res.headers });
      }
    } catch {
      /* not JSON we recognise — replay verbatim below */
    }
    return new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
  }
  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      if (value) controller.enqueue(value);
      if (first.done) controller.close();
    },
    async pull(controller) {
      const r = await reader.read();
      if (r.done) controller.close();
      else controller.enqueue(r.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(replay, { status: res.status, statusText: res.statusText, headers: res.headers });
};

/** OpenAI-family client (chat + responses) with the error-aware fetch installed. */
function openAIClient(c: ProviderConfig): OpenAI {
  return new OpenAI({
    apiKey: c.apiKey || "local",
    baseURL: c.baseUrl ? normalizeApiBase(c.baseUrl) : undefined,
    fetch: errorAwareFetch,
  });
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ── Anthropic ────────────────────────────────────────────────────────────────

// Convert user attachments to Anthropic content blocks. Images → image blocks;
// PDFs → document blocks; other types are skipped (kept in the transcript for
// reference but not sent to the model).
function anthropicAttachmentBlocks(msg: ChatMessage): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const a of msg.attachments ?? []) {
    if (a.type === "image" && a.mimeType.startsWith("image/")) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: a.mimeType as "image/png", data: a.data },
      });
    } else if (a.mimeType === "application/pdf") {
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: a.data },
      } as Anthropic.ContentBlockParam);
    }
  }
  return blocks;
}

// tool_result's content-block-array form only accepts text/image blocks (no
// document/PDF) — narrower than the general attachment converter above.
function anthropicImageBlocks(msg: ChatMessage): (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] {
  return (msg.attachments ?? [])
    .filter((a) => a.type === "image" && a.mimeType.startsWith("image/"))
    .map((a) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: a.mimeType as "image/png", data: a.data },
    }));
}

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
      pushUser([{ type: "text", text: m.content ?? "" }, ...anthropicAttachmentBlocks(m)]);
    } else if (m.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.content?.trim()) content.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) });
      }
      if (content.length) out.push({ role: "assistant", content });
    } else if (m.role === "tool" && m.toolCallId) {
      const images = anthropicImageBlocks(m);
      pushUser([
        {
          type: "tool_result",
          tool_use_id: m.toolCallId,
          // Plain string when there's nothing else to attach (the overwhelmingly
          // common case) — only switch to the content-block-array form when a
          // tool actually attached an image, so most tool results keep the exact
          // shape they've always had.
          content: images.length ? [{ type: "text", text: m.content ?? "" }, ...images] : m.content ?? "",
        },
      ]);
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
    { signal: opts.signal, headers: { "X-Correlation-Id": opts.runId } },
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
      const images = (m.attachments ?? []).filter((a) => a.type === "image" && a.mimeType.startsWith("image/"));
      if (images.length) {
        // OpenAI chat multimodal: content is an array of text + image_url parts.
        out.push({
          role: "user",
          content: [
            { type: "text", text: m.content ?? "" },
            ...images.map((a) => ({ type: "image_url" as const, image_url: { url: `data:${a.mimeType};base64,${a.data}` } })),
          ],
        });
      } else {
        out.push({ role: "user", content: m.content ?? "" });
      }
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
      // Chat Completions' tool-message content is text-only — there's no way to
      // attach an image to the tool_call_id result itself. Fall back to a
      // synthetic follow-up user turn carrying just the image(s), so the model
      // still sees them immediately after the tool result they belong to.
      const images = (m.attachments ?? []).filter((a) => a.type === "image" && a.mimeType.startsWith("image/"));
      if (images.length) {
        out.push({
          role: "user",
          content: images.map((a) => ({ type: "image_url" as const, image_url: { url: `data:${a.mimeType};base64,${a.data}` } })),
        });
      }
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
  const client = openAIClient(c);
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
    { signal: opts.signal, headers: { "X-Correlation-Id": opts.runId } },
  );

  let text = "";
  const byIndex = new Map<number, TurnToolCall>();
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta as
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
      const images = (m.attachments ?? []).filter((a) => a.type === "image" && a.mimeType.startsWith("image/"));
      if (images.length) {
        input.push({
          role: "user",
          content: [
            { type: "input_text", text: m.content ?? "" },
            ...images.map((a) => ({ type: "input_image", image_url: `data:${a.mimeType};base64,${a.data}` })),
          ],
        });
      } else {
        input.push({ role: "user", content: m.content ?? "" });
      }
    } else if (m.role === "assistant") {
      if (m.content?.trim()) input.push({ role: "assistant", content: m.content });
      for (const tc of m.toolCalls ?? []) {
        input.push({ type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
      }
    } else if (m.role === "tool" && m.toolCallId) {
      input.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content ?? "" });
      // Same limitation as Chat Completions above — function_call_output.output
      // here is text-only, so an attached image rides a synthetic follow-up
      // user turn instead.
      const images = (m.attachments ?? []).filter((a) => a.type === "image" && a.mimeType.startsWith("image/"));
      if (images.length) {
        input.push({
          role: "user",
          content: images.map((a) => ({ type: "input_image", image_url: `data:${a.mimeType};base64,${a.data}` })),
        });
      }
    }
  }
  return input;
}

async function responsesTurn(c: ProviderConfig, opts: TurnOpts): Promise<TurnResult> {
  const client = openAIClient(c);
  const stream = (await client.responses.create(
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
      stream: true,
      ...(c.maxTokens && c.maxTokens > 0 ? { max_output_tokens: c.maxTokens } : {}),
    } as Parameters<typeof client.responses.create>[0],
    { signal: opts.signal, headers: { "X-Correlation-Id": opts.runId } },
  )) as unknown as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>;

  let text = "";
  // function_call items keyed by output-item id; arguments accumulate across
  // delta events, finalized (authoritatively) on the matching done event.
  const openCalls = new Map<string, TurnToolCall>();
  const calls: TurnToolCall[] = [];
  for await (const ev of stream) {
    switch (ev.type) {
      // The Responses stream reports provider failures as in-band events, NOT
      // as an HTTP error or a top-level `error` field — so the OpenAI SDK does
      // not throw on them (it only throws for `data.error` / an `error` SSE
      // event). Local servers use these for context-overflow, bad-model, etc.
      // Throw so the agent loop settles the run as reason:"error" (→ error card)
      // instead of finishing an empty turn silently.
      case "error":
        throw new Error(ev.message || "the model provider returned an error");
      case "response.failed":
        throw new Error(ev.response.error?.message || "the model provider reported a failed response");
      case "response.output_text.delta":
        text += ev.delta;
        opts.onDelta({ kind: "text", messageId: opts.messageId, delta: ev.delta });
        break;
      // Some servers/models emit reasoning as a summary, others as raw text.
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        opts.onDelta({ kind: "reasoning", messageId: opts.messageId, delta: ev.delta });
        break;
      case "response.output_item.added":
        if (ev.item.type === "function_call") {
          const call: TurnToolCall = {
            id: ev.item.call_id || ev.item.id || `call-${opts.messageId}`,
            name: ev.item.name,
            arguments: "",
          };
          openCalls.set(ev.item.id ?? call.id, call);
          calls.push(call);
        }
        break;
      case "response.function_call_arguments.delta": {
        const call = openCalls.get(ev.item_id);
        if (call) call.arguments += ev.delta;
        break;
      }
      case "response.function_call_arguments.done": {
        const call = openCalls.get(ev.item_id);
        if (call) call.arguments = ev.arguments;
        break;
      }
    }
  }
  for (const call of calls) if (!call.arguments) call.arguments = "{}";
  return { text, toolCalls: calls };
}
