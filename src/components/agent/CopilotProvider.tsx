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
import { DiscoveryActions } from "./DiscoveryActions";
import { useActiveConversationId } from "@/lib/agent/conversations";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";

interface ProviderCfg {
  provider?: string;
  hasApiKey?: boolean;
  baseUrl?: string;
}

// Suppress CopilotKit's noisy AbortError console.error calls. These fire
// whenever a streaming request is cancelled by navigation or conversation
// deletion — expected teardown, not real errors.
const _origConsoleError = typeof console !== "undefined" ? console.error.bind(console) : null;
if (_origConsoleError && !("_ckAbortSuppressed" in console)) {
  (console as unknown as Record<string, unknown>)._ckAbortSuppressed = true;
  console.error = (...args: unknown[]) => {
    const first = String(args[0] ?? "");
    if (first.includes("[CopilotKit]") && (
      String(args[1] ?? "").includes("AbortError") ||
      String(args[1] ?? "").includes("aborted") ||
      first.includes("AbortError") ||
      first.includes("aborted")
    )) return;
    _origConsoleError(...args);
  };
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

  // Tool gating (allowlist 016 + deferred 025) is enforced server-side in the
  // copilotkit route's withToolGate middleware. The client registers every
  // action plainly; here we only resolve whether web search is available for
  // the current provider (used to enable the WebSearchActions tool).
  const [loaded, setLoaded] = useState<{
    agentId?: string;
    webSearchAvailable: boolean;
  } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch("/api/agent/provider")
        .then((r) => r.json())
        .then((providerData: { config?: ProviderCfg }) => {
          if (!alive) return;
          const cfg = providerData.config ?? {};
          const p = cfg.provider ?? "";
          const webSearchAvailable =
            ((p === "anthropic" || p === "openai" || p === "openai-codex") && !!cfg.hasApiKey) ||
            (p === "openai-responses" && (!!cfg.hasApiKey || !!cfg.baseUrl));
          setLoaded({ agentId, webSearchAvailable });
        })
        .catch(() => alive && setLoaded({ agentId, webSearchAvailable: false }));
    };
    load();
    // Re-check provider-backed web search availability when Settings changes or
    // the tab regains focus. Tool allowlists/deferred visibility are resolved by
    // `/api/copilotkit` on each model request.
    const onUpdated = () => load();
    const onVisibility = () => { if (document.visibilityState === "visible") load(); };
    window.addEventListener("bos:agent-updated", onUpdated);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      window.removeEventListener("bos:agent-updated", onUpdated);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [agentId]);

  const ready = loaded !== null && loaded.agentId === agentId;
  const webSearchAvailable = ready ? loaded!.webSearchAvailable : false;

  return (
    <CopilotKit key={agentId ?? "none"} runtimeUrl={runtimeUrl} threadId={threadId}>
      {ready && (
        <>
          <DiscoveryActions agentId={agentId} />
          <OSActions />
          <McpActions agentId={agentId} />
          <WebSearchActions webSearchAvailable={webSearchAvailable} />
          <SubAgentActions agentId={agentId} />
          <MemoryActions agentId={agentId} />
          <DevActions agentId={agentId} />
          <ConfigActions />
          <SkillsActions />
          <SelfImprovementActions agentId={agentId} conversationId={threadId} />
          <DocsActions />
          <GitActions agentId={agentId} />
          <RunCommandActions />
          <WorkflowActions />
          <SpecActions agentId={agentId} />
          <IntegrationActions />
          <ScratchpadActions agentId={agentId} />
          <ToolCallRetry />
          {children}
        </>
      )}
    </CopilotKit>
  );
}
