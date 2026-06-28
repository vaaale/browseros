"use client";

import { useEffect, useState } from "react";
import { CopilotChat } from "@copilotkit/react-ui";
import "@copilotkit/react-ui/styles.css";
import { CopilotProvider } from "@/components/agent/CopilotProvider";
import { ChatToolRenderer } from "@/components/agent/ChatToolRenderer";
import { useChatPersistence } from "@/components/agent/ChatPersistence";
import { ReasoningAssistantMessage } from "@/components/agent/ReasoningAssistantMessage";
import { markdownRenderers } from "@/components/agent/MarkdownRenderers";
import { ConversationPanel } from "@/components/apps/assistant/ConversationPanel";
import { InfoPanel } from "@/components/apps/assistant/InfoPanel";
import { DEFAULT_GROUP } from "@/lib/agent/conversations";

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
}

// Embeddable assistant chat (012-embeddable-assistant). Mounts its OWN CopilotKit
// provider over this sub-tree so it can be pinned to an agent and its own
// conversation group, independent of the Assistant app — reusing the same chat,
// persistence, tool rendering, and side panels.
export function AssistantChat(props: AssistantChatProps) {
  const { agentId, group = DEFAULT_GROUP } = props;
  return (
    <CopilotProvider group={group} agentId={agentId}>
      <AssistantChatInner {...props} group={group} />
    </CopilotProvider>
  );
}

function AssistantChatInner({
  agentId,
  group = DEFAULT_GROUP,
  showConversations = true,
  showInfo = true,
  initialLabel,
}: AssistantChatProps) {
  useChatPersistence(group);
  const [instructions, setInstructions] = useState(FALLBACK_INSTRUCTIONS);

  useEffect(() => {
    const url = agentId ? `/api/assistant/agent?agentId=${encodeURIComponent(agentId)}` : "/api/assistant/agent";
    fetch(url)
      .then((r) => r.json())
      .then((d) => d.composed && setInstructions(d.composed))
      .catch(() => {});
  }, [agentId]);

  return (
    <div className="flex h-full" data-theme="dark" style={THEME_OVERRIDES}>
      <ChatToolRenderer />
      {showConversations && <ConversationPanel group={group} />}
      <div className="min-w-0 flex-1">
        <CopilotChat
          className="h-full"
          AssistantMessage={ReasoningAssistantMessage}
          markdownTagRenderers={markdownRenderers}
          instructions={instructions}
          labels={{ initial: initialLabel ?? "How can I help?" }}
        />
      </div>
      {showInfo && <InfoPanel />}
    </div>
  );
}
