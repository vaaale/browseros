// Recorded shape of a tool-heavy conversation used across the compaction tests.
// Exported as a plain array of AI-SDK v3 prompt messages. No external deps.

import type { LanguageModelV3Prompt } from "@ai-sdk/provider";

type Msg = LanguageModelV3Prompt[number];

let callIdCounter = 0;
function nextCallId(): string {
  callIdCounter++;
  return `call_${callIdCounter}`;
}

export function resetIdCounter(): void {
  callIdCounter = 0;
}

export function userMessage(text: string): Msg {
  return { role: "user", content: [{ type: "text", text }] };
}

export function assistantText(text: string): Msg {
  return { role: "assistant", content: [{ type: "text", text }] };
}

export function assistantToolCall(toolName: string, input: unknown, id?: string): { message: Msg; callId: string } {
  const callId = id ?? nextCallId();
  return {
    callId,
    message: {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: callId, toolName, input }],
    },
  };
}

export function toolResult(callId: string, toolName: string, output: string): Msg {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: callId,
        toolName,
        output: { type: "text", value: output },
      },
    ],
  };
}

/** Build a tool-heavy conversation with `turns` user turns, each turn ending
 *  with a small tool call round. Deterministic. */
export function buildToolHeavyConversation(turns: number): LanguageModelV3Prompt {
  resetIdCounter();
  const out: LanguageModelV3Prompt = [];
  out.push({ role: "system", content: "you are a test assistant" });
  for (let t = 0; t < turns; t++) {
    out.push(userMessage(`turn ${t}: please do the thing (${t}).`));
    const { message, callId } = assistantToolCall("do_thing", { turn: t });
    out.push(message);
    // Fill the tool result with enough text that clearing is measurable.
    const filler = "x".repeat(400);
    out.push(toolResult(callId, "do_thing", `result for turn ${t}: ${filler}`));
    out.push(assistantText(`I did the thing for turn ${t}.`));
  }
  return out;
}

/** A shorter, well-formed conversation used by pass-through / cache tests. */
export function buildTinyConversation(): LanguageModelV3Prompt {
  resetIdCounter();
  return [
    { role: "system", content: "you are a test assistant" },
    userMessage("hi"),
    assistantText("hello, how can I help?"),
    userMessage("what's 2+2?"),
    assistantText("2+2 is 4."),
  ];
}
