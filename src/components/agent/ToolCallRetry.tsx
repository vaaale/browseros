"use client";

import { useEffect, useRef } from "react";
import { useCopilotChatInternal } from "@copilotkit/react-core";

// Resilience for inference servers that intermittently emit tool calls as TEXT
// (e.g. `<tool_call>…` / `<function=…>`) instead of native function calls — those
// don't execute. When we detect that in the assistant's last message we silently
// regenerate the turn via reloadMessages: it drops the failed assistant message,
// re-runs from the last user prompt, and adds nothing to the transcript — so the
// bad reply is REPLACED (not appended to) and no correction message pollutes the
// history. Because the failure is intermittent, a plain re-roll usually lands a
// proper native call. Capped per user turn so a model that keeps failing can't
// loop forever.
const LEAK = /<tool_call\b|<\/tool_call>|<function\s*=|<\|tool[_ ]?call\|>/i;
const MAX_RETRIES = 2;

// CopilotKit 1.61 renders AG-UI messages — plain objects. Text turns carry their
// text in `content`; tool calls/results don't, so a string `content` is how we
// isolate text turns.
interface ChatMessage {
  id: string;
  role: string;
  content?: unknown;
}
type TextTurn = ChatMessage & { content: string };

export function ToolCallRetry() {
  // 1.61 dropped the gql `visibleMessages` (undefined at runtime); the live
  // messages and the regenerate action come from useCopilotChatInternal.
  const { messages, reloadMessages, isLoading } = useCopilotChatInternal();
  const initialized = useRef(false);
  const handledId = useRef<string | null>(null);
  const lastHumanId = useRef<string | null>(null);
  const retries = useRef(0);

  useEffect(() => {
    if (isLoading) return;
    if (!Array.isArray(messages)) return;

    // Keep only text-bearing user/assistant turns (skip tool calls and results).
    const texts = (messages as unknown as ChatMessage[]).filter(
      (m): m is TextTurn => (m.role === "assistant" || m.role === "user") && typeof m.content === "string",
    );
    const lastReversed = <T,>(arr: T[], pred: (x: T) => boolean): T | undefined => {
      for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return arr[i];
      return undefined;
    };

    // On first run, adopt current history as already-handled so we never retry
    // on stale messages from a resumed/restored conversation.
    if (!initialized.current) {
      initialized.current = true;
      handledId.current = lastReversed(texts, (m) => m.role === "assistant")?.id ?? null;
      lastHumanId.current = lastReversed(texts, (m) => m.role === "user")?.id ?? null;
      return;
    }

    // A new human message starts a fresh retry budget. (Regenerating reuses the
    // existing user message, so its id is unchanged and the budget is preserved.)
    const lastUser = lastReversed(texts, (m) => m.role === "user");
    if (lastUser && lastUser.id !== lastHumanId.current) {
      lastHumanId.current = lastUser.id;
      retries.current = 0;
    }

    const last = texts[texts.length - 1];
    if (!last || last.role !== "assistant" || last.id === handledId.current) return;
    handledId.current = last.id;

    if (LEAK.test(last.content) && retries.current < MAX_RETRIES && typeof reloadMessages === "function") {
      retries.current += 1;
      void reloadMessages(last.id);
    }
  }, [messages, isLoading, reloadMessages]);

  return null;
}
