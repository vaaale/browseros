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

export function CopilotProvider({ children }: { children: ReactNode }) {
  return (
    <CopilotKit runtimeUrl="/api/copilotkit">
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
      {children}
    </CopilotKit>
  );
}
