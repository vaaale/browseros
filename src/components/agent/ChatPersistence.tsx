"use client";

import { useEffect, useRef } from "react";
import { useCopilotChatInternal } from "@copilotkit/react-core";
import {
  loadConversationMessages,
  saveConversationMessages,
  useActiveConversationId,
} from "@/lib/agent/conversations";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";

/**
 * Bridges the chat agent's message list with on-disk persistence at
 * /Documents/Chats/<threadId>.json.
 *
 * CopilotKit 1.61 renders from the AG-UI `agent.messages` store, NOT the legacy
 * `useCopilotMessagesContext`. So we read/write that store directly. The provider
 * remounts per conversation (CopilotProvider keys CopilotKit on threadId), so the
 * threadId here is fixed for this mount's life: we load the file once and seed the
 * fresh agent via setMessages (no post-mount thread-switch race), then debounce-
 * save on every agent message change. `agent.messages` are plain AG-UI objects
 * ({ id, role, content, toolCalls? }) and serialize as-is, so no class
 * rehydration is needed on load.
 *
 * Exposed as a hook (not a component) so the host calls one
 * useCopilotChatInternal() instead of adding another chat-agent subscriber.
 */

const SAVE_DEBOUNCE_MS = 400;

export function useChatPersistence(agentId: string = DEFAULT_AGENT_ID): { isLoading: boolean } {
  const threadId = useActiveConversationId(agentId);
  const { agent, setMessages, isLoading } = useCopilotChatInternal();

  const claimedRef = useRef<string | null>(null);
  const loadedForRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setMessagesRef = useRef(setMessages);
  useEffect(() => {
    setMessagesRef.current = setMessages;
  });

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Abort any in-flight run on unmount. The provider now remounts per
  // conversation (CopilotProvider keys CopilotKit on threadId), so switching
  // away tears down this whole subtree and disposes the agent — this abort is
  // the hygiene step that stops a dangling stream (e.g. mid web_search) before
  // the instance is discarded, rather than leaving a fetch running detached.
  useEffect(() => {
    if (!agent) return;
    const a = agent as unknown as { isRunning?: boolean; abortRun?: () => void };
    return () => {
      try {
        if (a.isRunning && typeof a.abortRun === "function") a.abortRun();
      } catch {
        /* best-effort; teardown must never throw */
      }
    };
  }, [agent, threadId]);

  useEffect(() => {
    if (!agent || !threadId || threadId === "default") return;
    if (claimedRef.current === threadId) return;
    claimedRef.current = threadId;
    loadedForRef.current = null;
    void (async () => {
      const raw = await loadConversationMessages(threadId);
      if (!mountedRef.current || claimedRef.current !== threadId) return;
      setMessagesRef.current(raw as Parameters<typeof setMessages>[0]);
      loadedForRef.current = threadId;
    })();
  }, [agent, threadId]);

  useEffect(() => {
    if (!agent || !threadId || threadId === "default") return;
    const sub = agent.subscribe({
      onMessagesChanged: ({ messages }) => {
        if (loadedForRef.current !== threadId) return;
        const snapshot = messages as unknown[];
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
