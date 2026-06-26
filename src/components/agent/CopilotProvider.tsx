"use client";

import { CopilotKit } from "@copilotkit/react-core";
import type { ReactNode } from "react";
import { OSActions } from "./OSActions";
import { McpActions } from "./McpActions";
import { SubAgentActions } from "./SubAgentActions";
import { MemoryActions } from "./MemoryActions";
import { DevActions } from "./DevActions";

export function CopilotProvider({ children }: { children: ReactNode }) {
  return (
    <CopilotKit runtimeUrl="/api/copilotkit">
      <OSActions />
      <McpActions />
      <SubAgentActions />
      <MemoryActions />
      <DevActions />
      {children}
    </CopilotKit>
  );
}
