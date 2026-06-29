import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { DEFAULT_MAX_TOKENS, getProviderConfig, type ProviderConfig } from "./provider";
import { familyOf } from "./provider-meta";

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
  const apiKey = c.apiKey || (c.provider === "openai-compatible" ? "local" : "MISSING");
  return new OpenAI({ apiKey, baseURL: c.baseUrl || undefined });
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

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.prompt });
  const res = await openaiClient(c).chat.completions.create({
    model: c.model,
    messages,
    ...openaiTokenParam(c, maxTokens),
  });
  return messageText(res.choices[0]?.message);
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
    const res = await client.chat.completions.create({
      model: c.model,
      messages,
      tools: toolSchemas,
      ...openaiTokenParam(c, c.maxTokens),
    });
    const msg = res.choices[0]?.message;
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
    return { text: messageText(msg).trim(), steps: step + 1, toolCalls };
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
  return familyOf(c.provider) === "anthropic"
    ? anthropicToolLoop(c, opts.system, opts.prompt, opts.tools, maxSteps, opts.onEvent)
    : openaiToolLoop(c, opts.system, opts.prompt, opts.tools, maxSteps, opts.onEvent);
}
