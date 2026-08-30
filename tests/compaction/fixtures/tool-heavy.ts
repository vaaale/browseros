// Recorded shape of a tool-heavy conversation used across the compaction
// tests. ChatMessage-native (src/lib/assistant/messages.ts) — no AI-SDK v3
// prompt intermediate. No external deps.

import type { ChatMessage } from "../../../src/lib/assistant/messages";

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter++;
  return `${prefix}_${idCounter}`;
}

export function resetIdCounter(): void {
  idCounter = 0;
}

export function userMessage(text: string): ChatMessage {
  return { id: nextId("user"), role: "user", content: text };
}

export function assistantText(text: string): ChatMessage {
  return { id: nextId("asst"), role: "assistant", content: text };
}

export function assistantToolCall(toolName: string, args: Record<string, unknown>, id?: string): { message: ChatMessage; callId: string } {
  const callId = id ?? nextId("call");
  return {
    callId,
    message: {
      id: nextId("asst"),
      role: "assistant",
      content: "",
      toolCalls: [{ id: callId, type: "function", function: { name: toolName, arguments: JSON.stringify(args) } }],
    },
  };
}

export function toolResult(callId: string, output: string): ChatMessage {
  return { id: nextId("tool"), role: "tool", content: output, toolCallId: callId };
}

/** Build a tool-heavy conversation with `turns` user turns, each turn ending
 *  with a small tool call round. Deterministic. */
export function buildToolHeavyConversation(turns: number): ChatMessage[] {
  resetIdCounter();
  const out: ChatMessage[] = [];
  for (let t = 0; t < turns; t++) {
    out.push(userMessage(`turn ${t}: please do the thing (${t}).`));
    const { message, callId } = assistantToolCall("do_thing", { turn: t });
    out.push(message);
    // Fill the tool result with enough text that clearing is measurable.
    const filler = "x".repeat(400);
    out.push(toolResult(callId, `result for turn ${t}: ${filler}`));
    out.push(assistantText(`I did the thing for turn ${t}.`));
  }
  return out;
}

/** A shorter, well-formed conversation used by pass-through / cache tests. */
export function buildTinyConversation(): ChatMessage[] {
  resetIdCounter();
  return [
    userMessage("hi"),
    assistantText("hello, how can I help?"),
    userMessage("what's 2+2?"),
    assistantText("2+2 is 4."),
  ];
}
