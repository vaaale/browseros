"use client";

import { useEffect, useRef } from "react";
import { useCopilotChatInternal } from "@copilotkit/react-core";
import {
  loadConversationMessages,
  saveConversationMessages,
  useActiveConversationId,
} from "@/lib/agent/conversations";

/**
 * Bridges the chat agent's message list with on-disk persistence at
 * /Documents/Chats/<threadId>.json.
 *
 * CopilotKit 1.61 renders from the AG-UI `agent.messages` store, NOT the legacy
 * `useCopilotMessagesContext`. So we read/write that store directly: on thread
 * change we load the file and push it into the agent via setMessages; on every
 * agent message change we debounce-save the agent's messages. `agent.messages`
 * are plain AG-UI objects ({ id, role, content, toolCalls? }) and serialize
 * as-is, so no class rehydration is needed on load.
 *
 * Exposed as a hook (not a component) so the host calls one
 * useCopilotChatInternal() instead of adding another chat-agent subscriber.
 */

const SAVE_DEBOUNCE_MS = 400;

export function useChatPersistence(): { isLoading: boolean } {
  const threadId = useActiveConversationId();
  const { agent, setMessages, isLoading } = useCopilotChatInternal();

  // The thread whose messages are currently loaded into the agent. Gates saves
  // so we never write one thread's messages under another id during a swap.
  const loadedForRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep the latest setMessages in a ref so the load effect does NOT depend on
  // its identity. Otherwise the effect re-runs on unrelated re-renders (e.g. the
  // version-control toolbar updating) and reloads a trimmed disk copy OVER an
  // in-flight turn — wiping the live conversation and orphaning the run.
  const setMessagesRef = useRef(setMessages);
  useEffect(() => {
    setMessagesRef.current = setMessages;
  });

  // Load persisted messages into the agent only when the thread (or agent)
  // actually changes — never on a plain re-render.
  useEffect(() => {
    if (!agent || !threadId || threadId === "default") return;
    let cancelled = false;
    loadedForRef.current = null;
    void (async () => {
      const raw = await loadConversationMessages(threadId);
      if (cancelled) return;
      // A non-GQL array is forwarded straight to agent.setMessages().
      setMessagesRef.current(raw as Parameters<typeof setMessages>[0]);
      loadedForRef.current = threadId;
    })();
    return () => {
      cancelled = true;
    };
  }, [agent, threadId]);

  // Debounce-save the agent's messages on every change for the loaded thread.
  // addMessage() mutates the messages array in place, so a render dependency
  // would miss new messages — subscribe to the agent's change event instead.
  useEffect(() => {
    if (!agent || !threadId || threadId === "default") return;
    const sub = agent.subscribe({
      onMessagesChanged: ({ messages }) => {
        if (loadedForRef.current !== threadId) return;
        const snapshot = messages as unknown[];
        // Never persist an empty snapshot over a real conversation — an empty
        // array here is a transient reset (thread swap / remount), not the user
        // clearing the chat.
        if (snapshot.length === 0) return;
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          void saveConversationMessages(threadId, snapshot);
        }, SAVE_DEBOUNCE_MS);
      },
    });
    return () => {
      sub.unsubscribe();
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [agent, threadId]);

  return { isLoading };
}
