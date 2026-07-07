import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { DEFAULT_MAX_TOKENS, getProviderConfig, type ProviderConfig } from "./provider";
import { familyOf, normalizeApiBase } from "./provider-meta";

// OpenAI deprecated `max_tokens` in favor of `max_completion_tokens` (and
// rejects the old field on newer models). Local OpenAI-compatible servers
// (LM Studio, llama.cpp, vLLM, …) still use the legacy `max_tokens`.
function openaiTokenField(c: ProviderConfig): "max_tokens" | "max_completion_tokens" {
  return c.provider === "openai-compatible" ? "max_tokens" : "max_completion_tokens";
}

function openaiTokenParam(c: ProviderConfig, maxTokens: number | undefined): Record<string, number> {
  return maxTokens && maxTokens > 0 ? { [openaiTokenField(c)]: maxTokens } : {};
}

export interface LlmTool {
  description?: string;
  /** JSON Schema for the tool input (accepted by both Anthropic and OpenAI). */
  parameters: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<string>;
  /**
   * Advisory: this tool is discoverable at runtime rather than always visible.
   * The loop honors visibility via the `hiddenIds` / `revealed` sets on
   * `runToolLoop`; this field is documentational for callers that want to
   * know whether the tool is deferred without consulting the registry.
   */
  deferred?: boolean;
}

export interface ToolLoopResult {
  text: string;
  steps: number;
  toolCalls: { tool: string; input: unknown }[];
}

export type ToolEvent = { tool: string; input: unknown };

const MAX_STEPS = 8;

function anthropicClient(c: ProviderConfig): Anthropic {
  return new Anthropic({ apiKey: c.apiKey || "MISSING", baseURL: c.baseUrl || undefined });
}

function openaiClient(c: ProviderConfig): OpenAI {
  const apiKey = c.apiKey || (c.provider === "openai-compatible" || c.provider === "openai-responses" ? "local" : "MISSING");
  const baseURL = c.baseUrl ? normalizeApiBase(c.baseUrl) : undefined;
  return new OpenAI({ apiKey, baseURL });
}

function extractResponsesText(output: unknown[]): string {
  return output
    .filter((item) => (item as Record<string, unknown>).type === "message")
    .flatMap((msg) => ((msg as Record<string, unknown>).content as unknown[]))
    .filter((blk) => (blk as Record<string, unknown>).type === "output_text")
    .map((blk) => (blk as Record<string, unknown>).text as string)
    .join("");
}

async function openaiResponsesComplete(
  c: ProviderConfig,
  system: string | undefined,
  prompt: string,
  maxTokens: number | undefined,
): Promise<string> {
  const client = openaiClient(c);
  const res = await (client.responses.create({
    model: c.model,
    input: prompt,
    ...(system ? { instructions: system } : {}),
    ...(maxTokens && maxTokens > 0 ? { max_output_tokens: maxTokens } : {}),
  } as Parameters<typeof client.responses.create>[0]) as unknown as Promise<Record<string, unknown>>);
  return extractResponsesText(res.output as unknown[]);
}

async function openaiResponsesToolLoop(
  c: ProviderConfig,
  system: string,
  prompt: string,
  tools: Record<string, LlmTool>,
  maxSteps: number,
  onEvent?: (e: ToolEvent) => void,
): Promise<ToolLoopResult> {
  const client = openaiClient(c);
  const toolSchemas = Object.entries(tools).map(([name, t]) => ({
    type: "function" as const,
    name,
    description: t.description ?? "",
    parameters: t.parameters,
  }));
  const allToolCalls: { tool: string; input: unknown }[] = [];

  // Start with the user prompt; grow the input array across steps.
  let input: unknown[] = [{ role: "user", content: prompt }];

  for (let step = 0; step < maxSteps; step++) {
    const res = await (client.responses.create({
      model: c.model,
      instructions: system,
      input: input as Parameters<typeof client.responses.create>[0]["input"],
      tools: toolSchemas as Parameters<typeof client.responses.create>[0]["tools"],
      ...(c.maxTokens && c.maxTokens > 0 ? { max_output_tokens: c.maxTokens } : {}),
    } as Parameters<typeof client.responses.create>[0]) as unknown as Promise<Record<string, unknown>>);

    const output = (res.output as unknown[]).map((i) => i as Record<string, unknown>);
    const fnCalls = output.filter((item) => item.type === "function_call");

    if (fnCalls.length === 0) {
      const text = extractResponsesText(output);
      return { text, steps: step + 1, toolCalls: allToolCalls };
    }

    const results: unknown[] = [];
    for (const call of fnCalls) {
      let callInput: Record<string, unknown> = {};
      try { callInput = JSON.parse((call.arguments as string) || "{}"); } catch { /* keep empty */ }
      onEvent?.({ tool: call.name as string, input: callInput });
      const t = tools[call.name as string];
      let out: string;
      try {
        out = t ? await t.execute(callInput) : `Unknown tool: ${call.name as string}`;
      } catch (e) {
        out = `Error: ${(e as Error).message}`;
      }
      allToolCalls.push({ tool: call.name as string, input: callInput });
      results.push({ type: "function_call_output", call_id: call.call_id as string, output: out });
    }

    // Next input: previous response output items + tool results
    input = [...output, ...results];
  }

  return {
    text: `Reached the step limit (${maxSteps} steps) before finishing. Partial changes may already be applied — review what was done and delegate a focused follow-up to continue, rather than restarting from scratch.`,
    steps: maxSteps,
    toolCalls: allToolCalls,
  };
}

/** A single, non-tool completion. */
export async function complete(opts: { system?: string; prompt: string; maxTokens?: number }): Promise<string> {
  const c = await getProviderConfig();
  const maxTokens = opts.maxTokens ?? c.maxTokens;

  if (familyOf(c.provider) === "anthropic") {
    // Anthropic requires `max_tokens` — fall back to a sensible default when unset.
    const res = await anthropicClient(c).messages.create({
      model: c.model,
      max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
      system: opts.system ? [{ type: "text", text: opts.system }] : undefined,
      messages: [{ role: "user", content: opts.prompt }],
    });
    return res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  }

  if (c.provider === "openai-responses") {
    return openaiResponsesComplete(c, opts.system, opts.prompt, maxTokens);
  }

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.prompt });
  // Stream and accumulate rather than requesting a single JSON body. Some
  // OpenAI-compatible servers (e.g. llama.cpp) frame non-streaming responses with a
  // Content-Length that Node's strict `undici` HTTP parser rejects
  // (`HPE_UNEXPECTED_CONTENT_LENGTH`), surfacing as an opaque "Connection error".
  // The chunked streaming response has no such framing, so it parses cleanly — this
  // is the same path the chat proxy already uses successfully against those servers.
  const stream = await openaiClient(c).chat.completions.create({
    model: c.model,
    messages,
    stream: true,
    ...openaiTokenParam(c, maxTokens),
  });
  let content = "";
  let reasoning = "";
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta as { content?: string | null; reasoning_content?: string } | undefined;
    if (delta?.content) content += delta.content;
    else if (delta?.reasoning_content) reasoning += delta.reasoning_content;
  }
  return content || reasoning;
}

// Reads assistant text, falling back to the non-standard `reasoning_content`
// field used by some "thinking" models (DeepSeek/Qwen style).
function messageText(msg: { content?: string | null; reasoning_content?: string } | undefined): string {
  if (!msg) return "";
  return msg.content || msg.reasoning_content || "";
}

async function anthropicToolLoop(
  c: ProviderConfig,
  system: string,
  prompt: string,
  tools: Record<string, LlmTool>,
  maxSteps: number,
  onEvent?: (e: ToolEvent) => void,
): Promise<ToolLoopResult> {
  const client = anthropicClient(c);
  const toolSchemas: Anthropic.Tool[] = Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  }));
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  const toolCalls: { tool: string; input: unknown }[] = [];

  for (let step = 0; step < maxSteps; step++) {
    const res = await client.messages.create({
      model: c.model,
      max_tokens: c.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
      tools: toolSchemas,
    });
    if (res.stop_reason === "tool_use") {
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of res.content) {
        if (block.type !== "tool_use") continue;
        onEvent?.({ tool: block.name, input: block.input });
        const t = tools[block.name];
        let out: string;
        try {
          out = t ? await t.execute(block.input as Record<string, unknown>) : `Unknown tool: ${block.name}`;
        } catch (e) {
          out = `Error: ${(e as Error).message}`;
        }
        toolCalls.push({ tool: block.name, input: block.input });
        results.push({ type: "tool_result", tool_use_id: block.id, content: out });
      }
      messages.push({ role: "assistant", content: res.content });
      messages.push({ role: "user", content: results });
      continue;
    }
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
    return { text, steps: step + 1, toolCalls };
  }
  return {
    text: `Reached the step limit (${maxSteps} steps) before finishing. Partial changes may already be applied — review what was done and delegate a focused follow-up to continue, rather than restarting from scratch.`,
    steps: maxSteps,
    toolCalls,
  };
}

async function openaiToolLoop(
  c: ProviderConfig,
  system: string,
  prompt: string,
  tools: Record<string, LlmTool>,
  maxSteps: number,
  onEvent?: (e: ToolEvent) => void,
): Promise<ToolLoopResult> {
  const client = openaiClient(c);
  const toolSchemas: OpenAI.Chat.Completions.ChatCompletionTool[] = Object.entries(tools).map(([name, t]) => ({
    type: "function",
    function: { name, description: t.description, parameters: t.parameters },
  }));
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    { role: "user", content: prompt },
  ];
  const toolCalls: { tool: string; input: unknown }[] = [];

  for (let step = 0; step < maxSteps; step++) {
    // Stream and accumulate rather than requesting a single JSON body — same
    // rationale as `complete()`: some OpenAI-compatible servers frame
    // non-streaming responses with a Content-Length that Node's `undici`
    // parser rejects (`HPE_UNEXPECTED_CONTENT_LENGTH`).
    const stream = await client.chat.completions.create({
      model: c.model,
      messages,
      tools: toolSchemas,
      stream: true,
      ...openaiTokenParam(c, c.maxTokens),
    });
    let content = "";
    let reasoning = "";
    const toolCallsAcc: OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[] = [];
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta as {
        content?: string | null;
        reasoning_content?: string;
        tool_calls?: Array<{
          index: number;
          id?: string;
          type?: "function";
          function?: { name?: string; arguments?: string };
        }>;
      } | undefined;
      if (delta?.content) content += delta.content;
      if (delta?.reasoning_content) reasoning += delta.reasoning_content;
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          const existing = toolCallsAcc[idx];
          if (!existing) {
            toolCallsAcc[idx] = {
              id: tc.id ?? "",
              type: "function",
              function: {
                name: tc.function?.name ?? "",
                arguments: tc.function?.arguments ?? "",
              },
            };
          } else {
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.function.name = tc.function.name;
            if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
          }
        }
      }
    }
    const reassembledToolCalls = toolCallsAcc.filter(Boolean);
    const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: content || null,
      ...(reassembledToolCalls.length ? { tool_calls: reassembledToolCalls } : {}),
    };
    if (msg?.tool_calls?.length) {
      messages.push(msg);
      for (const call of msg.tool_calls) {
        if (call.type !== "function") continue;
        const name = call.function.name;
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(call.function.arguments || "{}");
        } catch {
          /* leave empty */
        }
        onEvent?.({ tool: name, input });
        const t = tools[name];
        let out: string;
        try {
          out = t ? await t.execute(input) : `Unknown tool: ${name}`;
        } catch (e) {
          out = `Error: ${(e as Error).message}`;
        }
        toolCalls.push({ tool: name, input });
        messages.push({ role: "tool", tool_call_id: call.id, content: out });
      }
      continue;
    }
    return { text: messageText({ content, reasoning_content: reasoning }).trim(), steps: step + 1, toolCalls };
  }
  return {
    text: `Reached the step limit (${maxSteps} steps) before finishing. Partial changes may already be applied — review what was done and delegate a focused follow-up to continue, rather than restarting from scratch.`,
    steps: maxSteps,
    toolCalls,
  };
}

/** Provider-agnostic bounded tool-use loop. */
export async function runToolLoop(opts: {
  system: string;
  prompt: string;
  tools: Record<string, LlmTool>;
  maxSteps?: number;
  onEvent?: (e: ToolEvent) => void;
}): Promise<ToolLoopResult> {
  const c = await getProviderConfig();
  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  if (familyOf(c.provider) === "anthropic")
    return anthropicToolLoop(c, opts.system, opts.prompt, opts.tools, maxSteps, opts.onEvent);
  if (c.provider === "openai-responses")
    return openaiResponsesToolLoop(c, opts.system, opts.prompt, opts.tools, maxSteps, opts.onEvent);
  return openaiToolLoop(c, opts.system, opts.prompt, opts.tools, maxSteps, opts.onEvent);
}
