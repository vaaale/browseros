"use client";

import { CopilotKit } from "@copilotkit/react-core";
import type { ReactNode } from "react";
import { OSActions } from "./OSActions";
import { McpActions } from "./McpActions";
import { SubAgentActions } from "./SubAgentActions";
import { MemoryActions } from "./MemoryActions";
import { DevActions } from "./DevActions";
import { ConfigActions } from "./ConfigActions";
import { AssistantActions } from "./AssistantActions";
import { SkillsActions } from "./SkillsActions";
import { SelfImprovementActions } from "./SelfImprovementActions";
import { DocsActions } from "./DocsActions";
import { GitActions } from "./GitActions";
import { WorkflowActions } from "./WorkflowActions";
import { ToolCallRetry } from "./ToolCallRetry";
import { useActiveConversationId, DEFAULT_GROUP } from "@/lib/agent/conversations";

export function CopilotProvider({
  children,
  group = DEFAULT_GROUP,
  agentId,
}: {
  children: ReactNode;
  group?: string;
  agentId?: string;
}) {
  // Scope the chat to the group's active conversation; switching conversations
  // switches the CopilotKit thread. agentId (when embedded) scopes MCP servers
  // server-side via the runtime query param (012-embeddable-assistant).
  const threadId = useActiveConversationId(group);
  const runtimeUrl = agentId ? `/api/copilotkit?agent=${encodeURIComponent(agentId)}` : "/api/copilotkit";
  return (
    <CopilotKit runtimeUrl={runtimeUrl} threadId={threadId}>
      <OSActions />
      <McpActions agentId={agentId} />
      <SubAgentActions />
      <MemoryActions />
      <DevActions />
      <ConfigActions />
      <AssistantActions />
      <SkillsActions />
      <SelfImprovementActions />
      <DocsActions />
      <GitActions />
      <WorkflowActions />
      <ToolCallRetry />
      {children}
    </CopilotKit>
  );
}
