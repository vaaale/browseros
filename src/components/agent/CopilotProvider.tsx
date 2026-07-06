"use client";

import { CopilotKit } from "@copilotkit/react-core";
import { useEffect, useState, type ReactNode } from "react";
import { OSActions } from "./OSActions";
import { McpActions } from "./McpActions";
import { SubAgentActions } from "./SubAgentActions";
import { MemoryActions } from "./MemoryActions";
import { DevActions } from "./DevActions";
import { ConfigActions } from "./ConfigActions";
import { SkillsActions } from "./SkillsActions";
import { SelfImprovementActions } from "./SelfImprovementActions";
import { DocsActions } from "./DocsActions";
import { GitActions } from "./GitActions";
import { RunCommandActions } from "./RunCommandActions";
import { WorkflowActions } from "./WorkflowActions";
import { SpecActions } from "./SpecActions";
import { WebSearchActions } from "./WebSearchActions";
import { IntegrationActions } from "./IntegrationActions";
import { ScratchpadActions } from "./ScratchpadActions";
import { ToolCallRetry } from "./ToolCallRetry";
import { AgentCapabilitiesProvider } from "./agent-capabilities";
import { useActiveConversationId } from "@/lib/agent/conversations";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";

interface AgentInfo {
  id: string;
  tools?: string[];
}

export function CopilotProvider({
  children,
  agentId = DEFAULT_AGENT_ID,
}: {
  children: ReactNode;
  agentId?: string;
}) {
  const threadId = useActiveConversationId(agentId);
  const runtimeUrl = agentId
    ? `/api/copilotkit?agent=${encodeURIComponent(agentId)}${threadId ? `&conv=${encodeURIComponent(threadId)}` : ""}`
    : "/api/copilotkit";

  const [loaded, setLoaded] = useState<{ agentId?: string; allow: string[] | null } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/assistant/agent")
      .then((r) => r.json())
      .then((d: { agents?: AgentInfo[] }) => {
        if (!alive) return;
        const agent = (d.agents ?? []).find((a) => a.id === agentId);
        setLoaded({ agentId, allow: agent?.tools ?? null });
      })
      .catch(() => alive && setLoaded({ agentId, allow: null }));
    return () => {
      alive = false;
    };
  }, [agentId]);

  const ready = loaded !== null && loaded.agentId === agentId;
  const allow = ready ? loaded!.allow : null;

  return (
    <CopilotKit key={agentId ?? "none"} runtimeUrl={runtimeUrl} threadId={threadId}>
      {ready && (
        <AgentCapabilitiesProvider allow={allow}>
          <OSActions />
          <McpActions agentId={agentId} />
          <WebSearchActions />
          <SubAgentActions agentId={agentId} />
          <MemoryActions />
          <DevActions agentId={agentId} />
          <ConfigActions />
          <SkillsActions />
          <SelfImprovementActions />
          <DocsActions />
          <GitActions agentId={agentId} />
          <RunCommandActions />
          <WorkflowActions />
          <SpecActions agentId={agentId} />
          <IntegrationActions />
          <ScratchpadActions agentId={agentId} />
          <ToolCallRetry />
          {children}
        </AgentCapabilitiesProvider>
      )}
    </CopilotKit>
  );
}
