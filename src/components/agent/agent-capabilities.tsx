"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  deferredCapabilityIds,
  resolveActionGate,
} from "@/lib/agent/capabilities-registry";
import { useRevealed } from "@/lib/agent/revealed-store";

// Per-surface gate for main-chat actions (016-unified-agents). One agent has one
// capability allowlist that governs it in both contexts; this provides the
// active/pinned agent's allowed *action* set to the gated useCopilotAction shim.
//
// STRICT MODE (Phase B of the uniform agent behavior): an empty allowlist means
// ZERO tools (not "all"), and a null/undefined allowlist is treated as "still
// loading" so the gate stays permissive during the initial render. The
// resolveActionGate helper is the single source of truth for this decision.
//
// DEFERRED GATE (Phase A of the uniform agent behavior): tools present in the
// effective deferred set (registry defaults ∪ agent.deferredTools) are hidden
// from the model until they are revealed via find_tools in the current
// conversation. The gate consults the per-conversation revealed store.
//
// The provider also loads global tool-description overrides (Settings → Tools)
// so the gated useCopilotAction shim can swap an action's description at
// registration time — the LLM sees the user's edit without a page reload.

interface AgentCapabilities {
  isActionAllowed: (id: string) => boolean;
  isDeferredAndHidden: (id: string) => boolean;
  descriptionFor: (id: string) => string | undefined;
}

const ALLOW_ALL: AgentCapabilities = {
  isActionAllowed: () => true,
  isDeferredAndHidden: () => false,
  descriptionFor: () => undefined,
};
const Ctx = createContext<AgentCapabilities>(ALLOW_ALL);

export function useAgentCapabilities(): AgentCapabilities {
  return useContext(Ctx);
}

export function AgentCapabilitiesProvider({
  allow,
  deferredTools,
  conversationId,
  children,
}: {
  /** The agent's `tools` allowlist (unified ids). null/undefined = still loading. */
  allow: string[] | null | undefined;
  /** The agent's per-agent deferred list (additive to registry defaults). */
  deferredTools: string[];
  /** Active conversation id — keys the revealed set for this loop. */
  conversationId: string;
  children: ReactNode;
}) {
  const [overrides, setOverrides] = useState<Record<string, { description?: string; deferred?: boolean }>>({});

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch("/api/tool-descriptions")
        .then((r) => r.json())
        .then((d: { overrides?: Record<string, { description?: string; deferred?: boolean }> }) => {
          if (!alive) return;
          setOverrides(d.overrides ?? {});
        })
        .catch(() => { /* keep previous state */ });
    };
    load();
    const onUpdated = () => load();
    window.addEventListener("bos:tool-descriptions-updated", onUpdated);
    return () => {
      alive = false;
      window.removeEventListener("bos:tool-descriptions-updated", onUpdated);
    };
  }, []);

  // Subscribe reactively to the revealed set for THIS conversation. Reveals
  // (via find_tools) trigger a re-render so newly-revealed actions flip from
  // `available: "disabled"` → `available: true` on the next registration pass.
  const revealed = useRevealed(conversationId);

  const value = useMemo<AgentCapabilities>(() => {
    // effectiveDeferred = registry defaults ∪ per-agent deferredTools
    const effectiveDeferred = new Set<string>([
      ...deferredCapabilityIds(),
      ...deferredTools,
    ]);
    const revealedSet = new Set(revealed);
    return {
      isActionAllowed: resolveActionGate(allow),
      isDeferredAndHidden: (id) => effectiveDeferred.has(id) && !revealedSet.has(id),
      descriptionFor: (id) => overrides[id]?.description,
    };
  }, [allow, deferredTools, revealed, overrides]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
