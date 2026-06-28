"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CopilotChat } from "@copilotkit/react-ui";
import "@copilotkit/react-ui/styles.css";
import { CheckCircle2, Loader2 } from "lucide-react";
import { CopilotProvider } from "@/components/agent/CopilotProvider";
import { ChatToolRenderer } from "@/components/agent/ChatToolRenderer";
import { useChatPersistence } from "@/components/agent/ChatPersistence";
import { ReasoningAssistantMessage } from "@/components/agent/ReasoningAssistantMessage";
import { markdownRenderers } from "@/components/agent/MarkdownRenderers";
import { ConversationPanel } from "@/components/apps/assistant/ConversationPanel";
import { InfoPanel } from "@/components/apps/assistant/InfoPanel";
import { AgentSelector } from "@/components/apps/assistant/AgentSelector";
import { CardScopeProvider } from "@/lib/agent/card-collapse";
import { DEFAULT_GROUP, useConversations, newConversation } from "@/lib/agent/conversations";

const FALLBACK_INSTRUCTIONS = "You are the BrowserOS assistant.";

const THEME_OVERRIDES: React.CSSProperties = {
  ["--copilot-kit-primary-color" as string]: "#5b8cff",
  ["--copilot-kit-contrast-color" as string]: "#ffffff",
  ["--copilot-kit-background-color" as string]: "#0f1117",
};

export interface AssistantChatProps {
  /** Pin the chat to a specific agent; defaults to the global active personality. */
  agentId?: string;
  /** Conversation partition; defaults to the Assistant group. */
  group?: string;
  showConversations?: boolean;
  showInfo?: boolean;
  initialLabel?: string;
  /** Assistant mode: show all conversation groups (nested) and switch between
   *  them (each group implies its agent); shows the personality selector. */
  allGroups?: boolean;
  /** Extra nodes rendered INSIDE this surface's CopilotKit provider — e.g. a host
   *  app registering `useCopilotAction` tools the embedded agent can call to drive
   *  the app's UI. They render no visible chrome (the action components return null). */
  children?: ReactNode;
}

// Embeddable assistant chat (012-embeddable-assistant). Mounts its OWN CopilotKit
// provider over this sub-tree so it can be pinned to an agent and a conversation
// group, independent of the Assistant app — reusing the same chat, persistence,
// tool rendering, and side panels. In `allGroups` mode it follows the selected
// conversation across groups (a non-default group implies an agent of the same id).
export function AssistantChat(props: AssistantChatProps) {
  const [group, setGroup] = useState(props.group ?? DEFAULT_GROUP);
  const agentId = group === DEFAULT_GROUP ? props.agentId : group;
  return (
    <CopilotProvider group={group} agentId={agentId}>
      {props.children}
      <AssistantChatInner {...props} group={group} agentId={agentId} onPickGroup={props.allGroups ? setGroup : undefined} />
    </CopilotProvider>
  );
}

function AssistantChatInner({
  agentId,
  group = DEFAULT_GROUP,
  showConversations = true,
  showInfo = true,
  initialLabel,
  allGroups,
  onPickGroup,
}: AssistantChatProps & { onPickGroup?: (group: string) => void }) {
  const { isLoading } = useChatPersistence(group);
  const conv = useConversations(group);
  const [instructions, setInstructions] = useState(FALLBACK_INSTRUCTIONS);

  // An embed's group starts empty (only the default "assistant" group is seeded),
  // so create its first conversation on open. setTimeout defers the store write
  // out of the effect body.
  useEffect(() => {
    if (conv.loaded && !conv.activeId && conv.conversations.length === 0) {
      const t = setTimeout(() => void newConversation(group), 0);
      return () => clearTimeout(t);
    }
  }, [conv.loaded, conv.activeId, conv.conversations.length, group]);

  useEffect(() => {
    const url = agentId ? `/api/assistant/agent?agentId=${encodeURIComponent(agentId)}` : "/api/assistant/agent";
    fetch(url)
      .then((r) => r.json())
      .then((d) => d.composed && setInstructions(d.composed))
      .catch(() => {});
  }, [agentId]);

  return (
    <CardScopeProvider scope={group}>
      <div className="flex h-full" data-theme="dark" style={THEME_OVERRIDES}>
        <ChatToolRenderer />
        {showConversations && (allGroups ? <ConversationPanel onPickGroup={onPickGroup} /> : <ConversationPanel group={group} />)}
        <div className="flex min-w-0 flex-1 flex-col">
          {allGroups && (
            <div className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-white/[0.03] px-2 py-1 text-[11px]">
              <AgentSelector />
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
            />
          </div>
        </div>
        {showInfo && <InfoPanel />}
      </div>
    </CardScopeProvider>
  );
}
