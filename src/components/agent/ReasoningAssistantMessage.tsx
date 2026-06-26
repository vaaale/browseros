"use client";

import { useState } from "react";
import { AssistantMessage, type AssistantMessageProps } from "@copilotkit/react-ui";
import { Brain } from "lucide-react";

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

function splitReasoning(content: string): { reasoning: string; answer: string; live: boolean } {
  const start = content.indexOf(THINK_OPEN);
  if (start === -1) return { reasoning: "", answer: content, live: false };
  const afterOpen = start + THINK_OPEN.length;
  const close = content.indexOf(THINK_CLOSE, afterOpen);
  if (close === -1) {
    // Still streaming reasoning — no answer yet.
    return { reasoning: content.slice(afterOpen).trim(), answer: "", live: true };
  }
  return {
    reasoning: content.slice(afterOpen, close).trim(),
    answer: content.slice(close + THINK_CLOSE.length).replace(/^\s+/, ""),
    live: false,
  };
}

// Renders an assistant message with the model's reasoning (<think>…</think>) in
// a collapsible card and the answer via CopilotKit's default renderer (so the
// answer keeps proper markdown + the copy/regenerate toolbar).
export function ReasoningAssistantMessage(props: AssistantMessageProps) {
  const raw = typeof props.message?.content === "string" ? props.message.content : "";
  const { reasoning, answer, live } = splitReasoning(raw);
  // Auto-expand while thinking; collapse once the answer arrives. The user can
  // override either way (null = follow `live`).
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? live;

  const answerMessage = props.message ? { ...props.message, content: answer } : props.message;

  return (
    <div>
      {reasoning && (
        <details
          open={open}
          onToggle={(e) => setUserOpen((e.currentTarget as HTMLDetailsElement).open)}
          className="mb-2 overflow-hidden rounded-lg border border-white/10 bg-white/[0.03]"
        >
          <summary className="flex cursor-pointer select-none items-center gap-1.5 px-2.5 py-1.5 text-xs text-white/55 marker:content-['']">
            <Brain size={13} className={live ? "animate-pulse text-violet-300" : "text-white/40"} />
            {live ? "Thinking…" : "Reasoning"}
          </summary>
          <div className="max-h-64 overflow-auto whitespace-pre-wrap px-3 pb-2.5 pt-1 text-[11px] leading-relaxed text-white/45">
            {reasoning}
          </div>
        </details>
      )}
      {/* Always render the default message so its subComponent (tool-call /
          generative UI) shows — even on tool-calling turns that have reasoning
          but no final answer text. */}
      <AssistantMessage {...props} message={answerMessage} />
    </div>
  );
}
