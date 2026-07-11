import "server-only";
import type { ChatMessage } from "@/lib/assistant/messages";
import type { CompactionPrompt } from "./estimate";
import { compactPrompt } from "./middleware";

// v2 compaction adapter. Server-owned runs feed the model through a raw provider
// SDK (model-turn.ts), not the ai-sdk LanguageModel the compaction middleware
// wraps — so this converts the v2 ChatMessage transcript to the v3 prompt shape
// the tested compaction core operates on, runs it, and converts back. The result
// is EPHEMERAL: it feeds one provider call only and is never persisted (the loop
// persists the original, uncompacted transcript), so synthetic message ids are
// fine and lossy round-tripping of dropped/summarized spans is intended.

function safeParseArgs(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** ChatMessage[] → v3 prompt. A leading system message (the composed prompt) is
 *  included so the budget estimate reflects real context size; it is stripped on
 *  the way back. */
function toPrompt(system: string, messages: ChatMessage[]): CompactionPrompt {
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant") for (const tc of m.toolCalls ?? []) toolNames.set(tc.id, tc.function.name);
  }
  const out: CompactionPrompt = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: [{ type: "text", text: m.content ?? "" }] });
    } else if (m.role === "assistant") {
      const parts: unknown[] = [];
      if (m.content?.trim()) parts.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        parts.push({ type: "tool-call", toolCallId: tc.id, toolName: tc.function.name, input: safeParseArgs(tc.function.arguments) });
      }
      out.push({ role: "assistant", content: parts as never });
    } else if (m.role === "tool" && m.toolCallId) {
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: m.toolCallId,
            toolName: toolNames.get(m.toolCallId) ?? "tool",
            output: { type: "text", value: m.content ?? "" },
          },
        ] as never,
      });
    }
  }
  return out;
}

function partsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => (p as { type?: string }).type === "text" || (p as { type?: string }).type === "reasoning")
    .map((p) => String((p as { text?: string }).text ?? ""))
    .join("");
}

let synthSeq = 0;
function synthId(): string {
  return `compacted-${Date.now().toString(36)}-${synthSeq++}`;
}

/** v3 prompt → ChatMessage[] (system messages dropped; ids synthetic). */
function fromPrompt(prompt: CompactionPrompt): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of prompt) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      out.push({ id: synthId(), role: "user", content: partsText(m.content) });
    } else if (m.role === "assistant") {
      const parts = Array.isArray(m.content) ? m.content : [];
      const toolCalls = parts
        .filter((p) => (p as { type?: string }).type === "tool-call")
        .map((p) => {
          const tc = p as { toolCallId: string; toolName: string; input: unknown };
          return {
            id: tc.toolCallId,
            type: "function" as const,
            function: { name: tc.toolName, arguments: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input ?? {}) },
          };
        });
      out.push({
        id: synthId(),
        role: "assistant",
        content: partsText(m.content),
        ...(toolCalls.length ? { toolCalls } : {}),
      });
    } else if (m.role === "tool") {
      for (const p of Array.isArray(m.content) ? m.content : []) {
        const tr = p as { type?: string; toolCallId?: string; output?: { value?: unknown } };
        if (tr.type !== "tool-result" || !tr.toolCallId) continue;
        const value = tr.output?.value;
        out.push({ id: synthId(), role: "tool", toolCallId: tr.toolCallId, content: typeof value === "string" ? value : JSON.stringify(value ?? "") });
      }
    }
  }
  return out;
}

/** Compact a v2 transcript for one provider call. Returns the input unchanged
 *  when compaction is disabled / below threshold / errors. */
export async function compactChatMessages(
  convId: string,
  system: string,
  messages: ChatMessage[],
  maxOutputTokens?: number,
): Promise<ChatMessage[]> {
  if (!convId || messages.length === 0) return messages;
  const prompt = toPrompt(system, messages);
  const compacted = await compactPrompt(convId, prompt, maxOutputTokens);
  if (compacted === prompt) return messages; // unchanged (identity signal from core)
  return fromPrompt(compacted);
}
