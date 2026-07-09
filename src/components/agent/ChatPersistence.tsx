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

  // Abort any in-flight run when leaving a conversation (threadId change) or on
  // unmount. The agent instance is shared per-agentId across ALL of its
  // conversations (CopilotKit's useAgent({ agentId })). A run left mid-flight
  // (e.g. web_search) when the user switches away keeps the shared agent's run
  // pipeline active; when it errors it enters RUN_ERROR, so returning to the
  // conversation throws "Cannot send event type 'RUN_STARTED': the run has
  // already errored with 'RUN_ERROR'" and the chat is stuck/stale. A clean
  // abort on leave stops the run before it can poison the shared agent.
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
