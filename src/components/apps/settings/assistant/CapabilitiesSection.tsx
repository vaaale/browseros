"use client";

import { McpGrid } from "./McpGrid";
import { SkillsGrid } from "./SkillsGrid";
import { ToolAccordions } from "./ToolAccordions";
import type { AgentMeta, CapabilitiesPatch, Catalog } from "./types";

export interface CapabilitiesSectionProps {
  agent: AgentMeta;
  catalog: Catalog;
  /**
   * Persist a capability-allowlist change. Only the class(es) that changed
   * appear on the patch; unset classes are preserved server-side. Empty
   * arrays continue to mean "all allowed" (FR-008 back-compat).
   */
  onSaveCapabilities: (patch: CapabilitiesPatch) => void;
}

/**
 * The "Capabilities" card of the Agent Details pane. Three vertically stacked
 * subsections: Skills → MCP servers → Tool categories. Each renders the full
 * catalog while writing back only the changed allowlist.
 */
export function CapabilitiesSection({
  agent,
  catalog,
  onSaveCapabilities,
}: CapabilitiesSectionProps) {
  return (
    <div className="mb-5 rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <h2 className="mb-3.5 border-b border-white/10 pb-2 text-[11px] font-semibold uppercase tracking-wide text-white/50">
        Capabilities
      </h2>

      <div className="mb-4">
        <h3 className="mb-2 text-[11px] font-semibold text-white/70">Skills Access</h3>
        <SkillsGrid
          all={catalog.skills}
          allowed={agent.skills}
          onChange={(skills) => onSaveCapabilities({ skills })}
        />
      </div>

      <div className="mb-4">
        <h3 className="mb-2 text-[11px] font-semibold text-white/70">MCP Servers</h3>
        <McpGrid
          all={catalog.mcp}
          allowed={agent.mcp}
          onChange={(mcp) => onSaveCapabilities({ mcp })}
        />
      </div>

      <div>
        <h3 className="mb-2 text-[11px] font-semibold text-white/70">Tool Access</h3>
        <ToolAccordions
          all={catalog.tools}
          allowed={agent.tools}
          onChange={(tools) => onSaveCapabilities({ tools })}
        />
      </div>
    </div>
  );
}
