"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { resolveActionGate } from "@/lib/agent/capabilities-registry";

// Per-surface gate for main-chat actions (016-unified-agents). One agent has one
// capability allowlist that governs it in both contexts; this provides the
// active/pinned agent's allowed *action* set to the gated useCopilotAction shim.
//
// Back-compat rule: an action is allowed UNLESS the agent's allowlist explicitly
// names ≥1 action id and this action isn't among them. So an unset/empty allowlist
// — or a legacy allowlist that lists only server *tool* ids — leaves all actions
// enabled (no agent silently loses its actions on upgrade).
//
// The provider also loads global tool-description overrides (Settings → Tools)
// so the gated useCopilotAction shim can swap an action's description at
// registration time — the LLM sees the user's edit without a page reload.

interface AgentCapabilities {
  isActionAllowed: (id: string) => boolean;
  descriptionFor: (id: string) => string | undefined;
}

const ALLOW_ALL: AgentCapabilities = { isActionAllowed: () => true, descriptionFor: () => undefined };
const Ctx = createContext<AgentCapabilities>(ALLOW_ALL);

export function useAgentCapabilities(): AgentCapabilities {
  return useContext(Ctx);
}

export function AgentCapabilitiesProvider({
  allow,
  children,
}: {
  /** The agent's `tools` allowlist (unified ids). null/undefined while loading = all. */
  allow: string[] | null | undefined;
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

  const value = useMemo<AgentCapabilities>(
    () => ({
      isActionAllowed: resolveActionGate(allow),
      descriptionFor: (id) => overrides[id]?.description,
    }),
    [allow, overrides],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
