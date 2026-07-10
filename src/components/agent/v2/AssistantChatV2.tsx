"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { CardScopeProvider } from "@/lib/agent/card-collapse";
import { useConversations, useActiveConversation, newConversation } from "@/lib/agent/conversations";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";
import { useOSStore } from "@/store/os-provider";
import { chatFontCss } from "@/os/chat-fonts";
import { ConversationPanel } from "@/components/apps/assistant/ConversationPanel";
import { AgentSelector, ConversationSelector, FeatureBranchSelector } from "@/components/apps/assistant/AgentSelector";
import { SelfImproveIndicator } from "@/components/agent/SelfImproveIndicator";
import { openConversation, registerFrontendTool, type FrontendToolHandler } from "@/lib/assistant/client/run-client";
import { useChatState } from "@/lib/assistant/client/chat-store";
import type { ToolDeclaration } from "@/lib/assistant/tools";
import { MessageListV2 } from "./MessageListV2";
import { ChatInputV2 } from "./ChatInputV2";
import { FrontendToolsV2 } from "./FrontendToolsV2";

// The embeddable Assistant, v2 — server-owned runs. Same surface API as the
// CopilotKit-era AssistantChat (agentId / showConversations / allGroups /
// conversationsInToolbar / initialLabel), plus the explicit embed contract:
//   tools: surface-scoped frontend tools (declaration + handler) that exist
//   only while this surface is mounted and are dispatched back to it by the
//   server loop (Build Studio's artifact_open / tree_refresh pattern).
// The info panel returns when session state moves server-side (Milestone D).

export interface SurfaceTool {
  declaration: ToolDeclaration;
  handler: FrontendToolHandler;
}

export interface AssistantChatV2Props {
  agentId?: string;
  showConversations?: boolean;
  initialLabel?: string;
  /** Assistant mode: all conversation groups + agent selector. */
  allGroups?: boolean;
  /** Compact conversation dropdown in the toolbar instead of the left panel. */
  conversationsInToolbar?: boolean;
  /** Surface-scoped frontend tools for THIS embed. */
  tools?: SurfaceTool[];
  children?: ReactNode;
}

export function AssistantChatV2(props: AssistantChatV2Props) {
  const [currentAgentId, setCurrentAgentId] = useState(props.agentId ?? DEFAULT_AGENT_ID);
  const activeConv = useActiveConversation(currentAgentId);
  const resolvedAgentId = activeConv?.agentId ?? props.agentId ?? DEFAULT_AGENT_ID;
  const conv = useConversations(resolvedAgentId);
  const conversationId = conv.activeId ?? "";
  const state = useChatState(conversationId);

  // Surface tools: bind handlers while mounted; declarations ride on each send.
  const tools = props.tools;
  useEffect(() => {
    if (!tools?.length) return;
    const unbind = tools.map((t) => registerFrontendTool(t.declaration.name, t.handler));
    return () => unbind.forEach((u) => u());
  }, [tools]);

  // Opening a conversation loads its (server-sanitized) history and re-attaches
  // to a still-running run — a reloaded tab is just a viewer catching up.
  useEffect(() => {
    if (conversationId) void openConversation(conversationId);
  }, [conversationId]);

  // A fresh embed with no conversations yet gets its first one.
  useEffect(() => {
    if (conv.loaded && !conv.activeId && conv.conversations.length === 0) {
      const t = setTimeout(() => void newConversation(resolvedAgentId), 0);
      return () => clearTimeout(t);
    }
  }, [conv.loaded, conv.activeId, conv.conversations.length, resolvedAgentId]);

  const ensureConversation = useCallback(() => newConversation(resolvedAgentId), [resolvedAgentId]);

  const settings = useOSStore((s) => s.settings);
  const chatFontSize = settings.chatFontSize ?? 15;
  const chatStyle: React.CSSProperties = {
    ["--bos-chat-font" as string]: chatFontCss(settings.chatFont ?? "system"),
    ["--bos-chat-font-size" as string]: `${chatFontSize}px`,
    ["--bos-chat-code-font-size" as string]: `${Math.max(11, chatFontSize - 1)}px`,
  };

  const showConversations = props.showConversations ?? true;
  const useToolbar = Boolean(props.conversationsInToolbar) && !props.allGroups;
  const showLeftPanel = showConversations && !useToolbar;
  const showToolbar = props.allGroups || useToolbar;

  return (
    <CardScopeProvider scope={`${resolvedAgentId}:${conversationId}`}>
      <div className="flex h-full bg-[#0f1117] text-white/90" data-bos-chat data-testid="assistant-v2" style={chatStyle}>
        <FrontendToolsV2 conversationId={conversationId} />
        {props.children}
        {showLeftPanel &&
          (props.allGroups ? (
            <ConversationPanel currentAgentId={currentAgentId} onPickAgent={setCurrentAgentId} />
          ) : (
            <ConversationPanel agentId={resolvedAgentId} />
          ))}
        <div className="flex min-w-0 flex-1 flex-col">
          {showToolbar && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 bg-white/[0.03] px-2 py-1 text-[11px]">
              {props.allGroups ? <AgentSelector agentId={currentAgentId} /> : <ConversationSelector agentId={resolvedAgentId} />}
              <FeatureBranchSelector agentId={props.allGroups ? currentAgentId : resolvedAgentId} />
              <span className="ml-auto flex items-center gap-1.5">
                {state.running ? (
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
          <div className="relative min-h-0 flex-1">
            <div className="pointer-events-none absolute right-3 top-2 z-10 flex flex-col items-end gap-1">
              <SelfImproveIndicator key={conversationId} conversationId={conversationId} />
            </div>
            <MessageListV2 conversationId={conversationId} agentId={resolvedAgentId} initialLabel={props.initialLabel} />
          </div>
          <ChatInputV2
            conversationId={conversationId}
            agentId={resolvedAgentId}
            surfaceTools={tools?.map((t) => t.declaration)}
            ensureConversation={ensureConversation}
          />
        </div>
      </div>
    </CardScopeProvider>
  );
}
