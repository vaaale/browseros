"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { resolveActionGate } from "@/lib/agent/capabilities-registry";

// Per-surface gate for main-chat actions (016-unified-agents). One agent has one
// capability allowlist that governs it in both contexts; this provides the
// active/pinned agent's allowed *action* set to the gated useCopilotAction shim.
//
// Back-compat rule: an action is allowed UNLESS the agent's allowlist explicitly
// names ≥1 action id and this action isn't among them. So an unset/empty allowlist
// — or a legacy allowlist that lists only server *tool* ids — leaves all actions
// enabled (no agent silently loses its actions on upgrade).

interface AgentCapabilities {
  isActionAllowed: (id: string) => boolean;
}

const ALLOW_ALL: AgentCapabilities = { isActionAllowed: () => true };
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
  const value = useMemo<AgentCapabilities>(() => ({ isActionAllowed: resolveActionGate(allow) }), [allow]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
