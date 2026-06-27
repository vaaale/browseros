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
import { useActiveConversationId } from "@/lib/agent/conversations";

export function CopilotProvider({ children }: { children: ReactNode }) {
  // Scope the chat to the active conversation; switching conversations switches
  // the CopilotKit thread.
  const threadId = useActiveConversationId();
  return (
    <CopilotKit runtimeUrl="/api/copilotkit" threadId={threadId}>
      <OSActions />
      <McpActions />
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
