"use client";

import { CopilotKit } from "@copilotkit/react-core";
import { useEffect, useState, type ReactNode } from "react";
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
import { SpecActions } from "./SpecActions";
import { WebSearchActions } from "./WebSearchActions";
import { ToolCallRetry } from "./ToolCallRetry";
import { AgentCapabilitiesProvider } from "./agent-capabilities";
import { useActiveConversationId, DEFAULT_GROUP } from "@/lib/agent/conversations";

interface AgentInfo {
  id: string;
  tools?: string[];
}

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
  // switches the CopilotKit thread. agentId (when embedded) pins the agent (012).
  const threadId = useActiveConversationId(group);
  const runtimeUrl = agentId ? `/api/copilotkit?agent=${encodeURIComponent(agentId)}` : "/api/copilotkit";

  // The pinned (or active) agent's capability allowlist gates which main-chat
  // actions are exposed (016-unified-agents). CopilotKit forbids an action's
  // `available` flag changing after it registers, so we mount the gated action
  // components only once the allowlist has loaded (`ready`) — each action then
  // registers ONCE with its final availability. On an agent switch we reset
  // `ready` (unmount) before refetching, so the allowlist never changes under a
  // mounted action.
  // `loaded` records the allowlist AND the agentId it was fetched for. `ready` is
  // derived: true only while the loaded allowlist matches the current agent — so on
  // an agent switch it is false (subtree unmounts) until the new allowlist arrives.
  // setState happens only in the async callback (never synchronously in the effect),
  // and the allowlist never changes under a mounted action (avoids CopilotKit's
  // "action configuration changed between renders").
  const [loaded, setLoaded] = useState<{ agentId?: string; allow: string[] | null } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/assistant/agent")
      .then((r) => r.json())
      .then((d: { agents?: AgentInfo[]; active?: string }) => {
        if (!alive) return;
        const id = agentId ?? d.active;
        const agent = (d.agents ?? []).find((a) => a.id === id);
        setLoaded({ agentId, allow: agent?.tools ?? null });
      })
      .catch(() => alive && setLoaded({ agentId, allow: null }));
    return () => {
      alive = false;
    };
  }, [agentId]);

  const ready = loaded !== null && loaded.agentId === agentId;
  const allow = ready ? loaded!.allow : null;

  // Mount the actions AND the chat together, only once the allowlist is known, so
  // the registered action set is final from the chat's first render. (Changing the
  // action set after the chat has rendered makes CopilotKit re-process tool calls,
  // which churns the live event cards.) `ready` resets on agent switch, remounting
  // this subtree with the new agent's allowlist.
  return (
    <CopilotKit runtimeUrl={runtimeUrl} threadId={threadId}>
      {ready && (
        <AgentCapabilitiesProvider allow={allow}>
          <OSActions />
          <McpActions agentId={agentId} />
          <WebSearchActions />
          <SubAgentActions group={group} />
          <MemoryActions />
          <DevActions />
          <ConfigActions />
          <AssistantActions />
          <SkillsActions />
          <SelfImprovementActions />
          <DocsActions />
          <GitActions />
          <WorkflowActions />
          <SpecActions />
          <ToolCallRetry />
          {children}
        </AgentCapabilitiesProvider>
      )}
    </CopilotKit>
  );
}
