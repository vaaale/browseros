"use client";

import { CopilotKit, useCopilotChatInternal } from "@copilotkit/react-core";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
import { useActiveConversationId, saveConversationMessages } from "@/lib/agent/conversations";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";
import { isUserStopActive } from "@/lib/agent/tool-kernel";

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

  // CopilotKit hands out ONE long-lived agent per agentId (useAgent({ agentId })),
  // shared across every conversation. We deliberately do NOT remount on threadId:
  // CopilotKit owns the runtime connection at this boundary, so keying on threadId
  // would reconnect on every conversation switch (janky) and churn the agent
  // through its provisional→connected swap each time. Instead ChatPersistence
  // reseeds the message list on threadId change (and across that agent swap), and
  // switching aborts any in-flight run. The one case that genuinely needs a fresh
  // agent is RUN_ERROR: the ag-ui pipeline stays poisoned and every later
  // RUN_STARTED throws until reload. `recoveryGen` bumps on a failed run to remount
  // with a clean, un-poisoned agent seeded from the just-flushed history.
  const [recoveryGen, setRecoveryGen] = useState(0);
  const lastRecoverRef = useRef(0);
  const recover = useCallback(() => {
    // Debounce: onRunFailed and onRunErrorEvent can both fire for one failure,
    // and a fresh agent that errors again shouldn't spin a remount loop.
    const now = Date.now();
    if (now - lastRecoverRef.current < 2000) return;
    lastRecoverRef.current = now;
    setRecoveryGen((g) => g + 1);
  }, []);

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
    <CopilotKit
      key={`${agentId ?? "none"}::${recoveryGen}`}
      runtimeUrl={runtimeUrl}
      threadId={threadId}
    >
      {ready && (
        <>
          <RunErrorRecovery threadId={threadId} onRecover={recover} />
          <RunStopGuard />
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

// Enforces "stop means STOP until the next send": while the kernel's user-stop
// flag is active, ANY run that initializes on this agent is aborted at the
// gate. This is deliberately belt-and-braces on top of CopilotKit's own
// follow-up suppression (stopGeneration → patched abortRun → run controller):
// if that suppression fails for any reason — model retry turns, suggestion
// runs, reconnect replays, recovery remounts — the run still dies here. The
// flag is cleared ONLY by an explicit user send (ChatInput), never by run
// lifecycle events, so no cascade can silently resume a stopped agent.
function RunStopGuard() {
  const { agent } = useCopilotChatInternal();
  useEffect(() => {
    const a = agent as unknown as {
      abortRun?: () => void;
      subscribe?: (s: { onRunInitialized?: () => void }) => { unsubscribe: () => void };
    } | undefined;
    if (!a || typeof a.subscribe !== "function") return;
    const sub = a.subscribe({
      onRunInitialized: () => {
        if (!isUserStopActive()) return;
        console.info("[BOS kernel] run initialized while stop active — aborting it");
        try {
          a.abortRun?.();
        } catch {
          /* best-effort; the tool gate still blocks its handlers */
        }
      },
    });
    return () => sub.unsubscribe();
  }, [agent]);
  return null;
}

// Watches the active agent for a failed/errored run and triggers a recovery
// remount (via onRecover → bumped provider key). Before remounting it flushes the
// current message list to disk so the fresh agent reseeds from ChatPersistence
// with the user's latest turn intact rather than the last debounced save.
function RunErrorRecovery({ threadId, onRecover }: { threadId: string; onRecover: () => void }) {
  const { agent } = useCopilotChatInternal();
  const onRecoverRef = useRef(onRecover);
  useEffect(() => {
    onRecoverRef.current = onRecover;
  });

  useEffect(() => {
    const a = agent as unknown as {
      messages?: unknown[];
      subscribe?: (s: {
        onRunFailed?: () => void;
        onRunErrorEvent?: () => void;
      }) => { unsubscribe: () => void };
    } | undefined;
    if (!a || typeof a.subscribe !== "function") return;

    let handled = false;
    const onFailure = () => {
      if (handled) return;
      // A user stop is not a failure: aborting a run can surface as a
      // failed-run event, and remount-recovery here would cascade (fresh core,
      // reconnect, replay) while the user explicitly wants the agent halted.
      if (isUserStopActive()) {
        console.info("[BOS kernel] run failed while stop active — skipping recovery remount");
        return;
      }
      handled = true;
      void (async () => {
        try {
          const msgs = a.messages;
          if (threadId && threadId !== "default" && Array.isArray(msgs) && msgs.length > 0) {
            await saveConversationMessages(threadId, msgs);
          }
        } catch {
          /* best-effort flush; recovery must proceed regardless */
        }
        onRecoverRef.current();
      })();
    };

    const sub = a.subscribe({ onRunFailed: onFailure, onRunErrorEvent: onFailure });
    return () => sub.unsubscribe();
  }, [agent, threadId]);

  return null;
}
