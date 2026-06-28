"use client";

import { useEffect } from "react";
import { AssistantMessage, type AssistantMessageProps } from "@copilotkit/react-ui";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { registerCard, toggleCard, useCardOpen, useCardScope } from "@/lib/agent/card-collapse";

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
//
// The reasoning card joins the shared accordion (see card-collapse): it opens
// when it first appears (while the model is thinking) and collapses as soon as a
// newer card — a tool call or the agent's own answer — is inserted. The answer
// is always shown; registering it just advances the accordion so the previous
// card collapses, satisfying "a new agent response collapses the previous card".
export function ReasoningAssistantMessage(props: AssistantMessageProps) {
  const raw = typeof props.message?.content === "string" ? props.message.content : "";
  const { reasoning, answer, live } = splitReasoning(raw);
  const messageId = props.message?.id ?? "";
  const reasonId = `reason:${messageId}`;
  const scope = useCardScope();
  const open = useCardOpen(scope, reasonId);

  const hasReasoning = reasoning.length > 0;
  const hasAnswer = answer.trim().length > 0;

  useEffect(() => {
    if (hasReasoning) registerCard(scope, reasonId);
  }, [hasReasoning, scope, reasonId]);

  useEffect(() => {
    if (hasAnswer) registerCard(scope, `answer:${messageId}`);
  }, [hasAnswer, scope, messageId]);

  const answerMessage = props.message ? { ...props.message, content: answer } : props.message;

  return (
    <div>
      {hasReasoning && (
        <div className="mb-2 overflow-hidden rounded-lg border border-white/10 bg-white/[0.03]">
          <button
            type="button"
            onClick={() => toggleCard(scope, reasonId)}
            aria-expanded={open}
            className="flex w-full cursor-pointer select-none items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-white/55"
          >
            {open ? <ChevronDown size={12} className="shrink-0 text-white/40" /> : <ChevronRight size={12} className="shrink-0 text-white/40" />}
            <Brain size={13} className={live ? "animate-pulse text-violet-300" : "text-white/40"} />
            {live ? "Thinking…" : "Reasoning"}
          </button>
          {open && (
            <div className="max-h-64 overflow-auto whitespace-pre-wrap px-3 pb-2.5 pt-1 text-[11px] leading-relaxed text-white/45">
              {reasoning}
            </div>
          )}
        </div>
      )}
      {/* Always render the default message so its subComponent (tool-call /
          generative UI) shows — even on tool-calling turns that have reasoning
          but no final answer text. */}
      <AssistantMessage {...props} message={answerMessage} />
    </div>
  );
}
