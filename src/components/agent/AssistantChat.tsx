"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CopilotChat } from "@copilotkit/react-ui";
import type { AttachmentUploadResult } from "@copilotkit/shared";
import "@copilotkit/react-ui/styles.css";
import { CheckCircle2, Loader2 } from "lucide-react";
import { CopilotProvider } from "@/components/agent/CopilotProvider";
import { ChatToolRenderer } from "@/components/agent/ChatToolRenderer";
import { useChatPersistence } from "@/components/agent/ChatPersistence";
import { ReasoningAssistantMessage } from "@/components/agent/ReasoningAssistantMessage";
import { markdownRenderers } from "@/components/agent/MarkdownRenderers";
import { ConversationPanel } from "@/components/apps/assistant/ConversationPanel";
import { InfoPanel } from "@/components/apps/assistant/InfoPanel";
import { AgentSelector, ConversationSelector, FeatureBranchSelector } from "@/components/apps/assistant/AgentSelector";
import { CardScopeProvider } from "@/lib/agent/card-collapse";
import { useConversations, useActiveConversation, newConversation } from "@/lib/agent/conversations";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";

const FALLBACK_INSTRUCTIONS = "You are the BrowserOS assistant.";

const THEME_OVERRIDES: React.CSSProperties = {
  ["--copilot-kit-primary-color" as string]: "#5b8cff",
  ["--copilot-kit-contrast-color" as string]: "#ffffff",
  ["--copilot-kit-background-color" as string]: "#0f1117",
};

export interface AssistantChatProps {
  /** Pin the chat to a specific agent. */
  agentId?: string;
  showConversations?: boolean;
  showInfo?: boolean;
  initialLabel?: string;
  /** Assistant mode: show all conversation groups (nested) and switch between
   *  them (each group implies its agent); shows the personality selector. */
  allGroups?: boolean;
  /** Show conversation list in a compact toolbar instead of the left panel.
   *  Only applies when showConversations=true and allGroups=false. */
  conversationsInToolbar?: boolean;
  /** Extra nodes rendered INSIDE this surface's CopilotKit provider. */
  children?: ReactNode;
}

export function AssistantChat(props: AssistantChatProps) {
  // In allGroups mode the active agent is the one whose conversation was last
  // selected; it starts on the default agent and updates when the user picks a
  // conversation that belongs to a different agent.
  const [currentAgentId, setCurrentAgentId] = useState(props.agentId ?? DEFAULT_AGENT_ID);
  const activeConv = useActiveConversation(currentAgentId);
  // The active conversation's agent wins over the prop; a fresh embed with no
  // conversation yet falls back to the prop, then the default.
  const resolvedAgentId = activeConv?.agentId ?? props.agentId ?? DEFAULT_AGENT_ID;

  return (
    <CopilotProvider agentId={resolvedAgentId}>
      {props.children}
      <AssistantChatInner
        {...props}
        currentAgentId={currentAgentId}
        resolvedAgentId={resolvedAgentId}
        onPickAgent={props.allGroups ? setCurrentAgentId : undefined}
      />
    </CopilotProvider>
  );
}

function useUploadAttachment() {
  return useCallback(async (file: File): Promise<AttachmentUploadResult> => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/attachments", { method: "POST", body: form });
    if (!res.ok) throw new Error(`Upload failed: ${res.statusText}`);
    const { url, mimeType } = (await res.json()) as { url: string; mimeType: string };
    return { type: "url", value: url, mimeType };
  }, []);
}

function AssistantChatInner({
  currentAgentId,
  resolvedAgentId,
  showConversations = true,
  showInfo = true,
  initialLabel,
  allGroups,
  conversationsInToolbar,
  onPickAgent,
}: Omit<AssistantChatProps, "agentId"> & {
  currentAgentId: string;
  resolvedAgentId: string;
  onPickAgent?: (agentId: string) => void;
}) {
  const { isLoading } = useChatPersistence(resolvedAgentId);
  const conv = useConversations(resolvedAgentId);
  const [instructions, setInstructions] = useState(FALLBACK_INSTRUCTIONS);
  const uploadAttachment = useUploadAttachment();

  const useToolbar = Boolean(conversationsInToolbar) && !allGroups;
  const showLeftPanel = showConversations && !useToolbar;
  // Toolbar for allGroups (agent selector) or compact embeds like Build Studio
  // (conversation dropdown), both paired with the feature-branch selector.
  const showToolbar = allGroups || useToolbar;

  // An embed's agent may start with no conversations — create the first one.
  useEffect(() => {
    if (conv.loaded && !conv.activeId && conv.conversations.length === 0) {
      const t = setTimeout(() => void newConversation(resolvedAgentId), 0);
      return () => clearTimeout(t);
    }
  }, [conv.loaded, conv.activeId, conv.conversations.length, resolvedAgentId]);

  useEffect(() => {
    const url = resolvedAgentId
      ? `/api/assistant/agent?agentId=${encodeURIComponent(resolvedAgentId)}`
      : "/api/assistant/agent";
    fetch(url)
      .then((r) => r.json())
      .then((d) => d.composed && setInstructions(d.composed))
      .catch(() => {});
  }, [resolvedAgentId]);

  return (
    <CardScopeProvider scope={resolvedAgentId}>
      <div className="flex h-full" data-theme="dark" style={THEME_OVERRIDES}>
        <ChatToolRenderer />
        {showLeftPanel && (
          allGroups
            ? <ConversationPanel currentAgentId={currentAgentId} onPickAgent={onPickAgent} />
            : <ConversationPanel agentId={resolvedAgentId} />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          {showToolbar && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 bg-white/[0.03] px-2 py-1 text-[11px]">
              {allGroups ? <AgentSelector agentId={currentAgentId} /> : <ConversationSelector agentId={resolvedAgentId} />}
              <FeatureBranchSelector agentId={allGroups ? currentAgentId : resolvedAgentId} />
              <span className="ml-auto flex items-center gap-1.5">
                {isLoading ? (
                  <>
                    <Loader2 size={12} className="animate-spin text-amber-300" />
                    <span className="text-amber-200">Working…</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 size={12} className="text-emerald-400" />
                    <span className="text-white/45">Ready</span>
                  </>
                )}
              </span>
            </div>
          )}
          <div className="min-h-0 flex-1">
            <CopilotChat
              className="h-full"
              AssistantMessage={ReasoningAssistantMessage}
              markdownTagRenderers={markdownRenderers}
              instructions={instructions}
              labels={{ initial: initialLabel ?? "How can I help?" }}
              attachments={{
                enabled: true,
                accept: "image/*,audio/*,video/*,application/pdf",
                onUpload: uploadAttachment,
              }}
            />
          </div>
        </div>
        {showInfo && <InfoPanel agentId={resolvedAgentId} />}
      </div>
    </CardScopeProvider>
  );
}
