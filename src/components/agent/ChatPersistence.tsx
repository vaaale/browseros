"use client";

import { useEffect, useRef } from "react";
import { useCopilotChatInternal } from "@copilotkit/react-core";
import {
  loadConversationMessages,
  saveConversationMessages,
  useActiveConversationId,
} from "@/lib/agent/conversations";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";
import { abortActiveToolRuns } from "@/lib/agent/tool-kernel";

/**
 * Bridges the chat agent's message list with on-disk persistence at
 * /Documents/Chats/<threadId>.json.
 *
 * CopilotKit 1.61 renders from the AG-UI `agent.messages` store, NOT the legacy
 * `useCopilotMessagesContext`. So we read/write that store directly: on thread
 * change (or when CopilotKit swaps the provisional agent for the connected one)
 * we load the file and seed it into the agent via setMessages; on every agent
 * message change we debounce-save the agent's messages. `agent.messages` are
 * plain AG-UI objects ({ id, role, content, toolCalls? }) and serialize as-is,
 * so no class rehydration is needed on load.
 *
 * Exposed as a hook (not a component) so the host calls one
 * useCopilotChatInternal() instead of adding another chat-agent subscriber.
 */

const SAVE_DEBOUNCE_MS = 400;

export function useChatPersistence(agentId: string = DEFAULT_AGENT_ID): { isLoading: boolean } {
  const threadId = useActiveConversationId(agentId);
  const { agent, setMessages, isLoading } = useCopilotChatInternal();

  // What we last seeded, keyed by BOTH the agent instance and the threadId.
  // CopilotKit returns a provisional agent while the runtime is (re)connecting,
  // then swaps in the real connected instance — a different object. Keying the
  // seed only on threadId (the old bug) seeds the throwaway provisional agent and
  // then skips the real one, leaving the chat empty until an unrelated switch.
  const seededRef = useRef<{ agent: unknown; threadId: string } | null>(null);
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
  // unmount. The agent is shared per-agentId across ALL of its conversations, so
  // a run left mid-flight (e.g. web_search) when the user switches away would
  // otherwise keep streaming into the shared agent; the cleanup here stops it
  // before we reseed for the next conversation.
  useEffect(() => {
    if (!agent) return;
    const a = agent as unknown as { isRunning?: boolean; abortRun?: () => void };
    return () => {
      try {
        if (a.isRunning && typeof a.abortRun === "function") a.abortRun();
      } catch {
        /* best-effort; teardown must never throw */
      }
      // abortRun only cancels the model stream — CopilotKit keeps awaiting any
      // in-flight client tool handler, which would then stream its result into
      // the NEXT conversation's reseeded agent. Settle them now with an
      // in-band error so the run closes out before the switch completes.
      abortActiveToolRuns(
        "the conversation was switched — the tool call was abandoned client-side; its work may still complete server-side",
      );
    };
  }, [agent, threadId]);

  useEffect(() => {
    if (!agent || !threadId || threadId === "default") return;
    const seeded = seededRef.current;
    if (seeded && seeded.agent === agent && seeded.threadId === threadId) return;
    seededRef.current = { agent, threadId };
    loadedForRef.current = null;
    void (async () => {
      const raw = await loadConversationMessages(threadId);
      const cur = seededRef.current;
      if (!mountedRef.current || !cur || cur.agent !== agent || cur.threadId !== threadId) return;
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
