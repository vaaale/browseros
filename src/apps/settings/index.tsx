"use client";

import { useCallback, useEffect, useState } from "react";
import type { ConfigSchemaView } from "@/lib/config/types";
import { AppearanceTab } from "@/components/apps/settings/AppearanceTab";
import { AgentsTab } from "@/components/apps/settings/AgentsTab";
import { SkillsTab } from "@/components/apps/settings/SkillsTab";
import { ToolsTab } from "@/components/apps/settings/ToolsTab";
import { AppsTab } from "@/components/apps/settings/AppsTab";
import { IntegrationsTab } from "@/components/apps/settings/IntegrationsTab";
import { DevHarnessTab } from "@/components/apps/settings/DevHarnessTab";
import { DataFsTab } from "@/components/apps/settings/DataFsTab";
import { VersionsTab } from "@/components/apps/settings/VersionsTab";
import { McpServersTab } from "@/components/apps/settings/McpServersTab";
import { LogsTab } from "@/components/apps/settings/LogsTab";
import { BuildStudioTab } from "@/components/apps/settings/BuildStudioTab";
import { RunCommandTab } from "@/components/apps/settings/RunCommandTab";
import { VoiceTab } from "@/components/apps/settings/VoiceTab";
import { ConfigForm } from "@/components/apps/settings/ConfigForm";
import { ProviderSettings } from "@/components/apps/ProviderSettings";

// Custom tab components keyed by ConfigSchema.customComponent.
const CUSTOM_TABS: Record<string, React.ComponentType> = {
  appearance: AppearanceTab,
  "ai-provider": ProviderSettings,
  agents: AgentsTab,
  skills: SkillsTab,
  tools: ToolsTab,
  mcp: McpServersTab,
  apps: AppsTab,
  integrations: IntegrationsTab,
  "build-studio": BuildStudioTab,
  "dev-harness": DevHarnessTab,
  datafs: DataFsTab,
  "self-modification": VersionsTab,
  logging: LogsTab,
  "run-command": RunCommandTab,
  voice: VoiceTab,
};

export default function SettingsApp() {
  const [schemas, setSchemas] = useState<ConfigSchemaView[]>([]);
  const [active, setActive] = useState<string>("");

  const load = useCallback(async () => {
    const res = await fetch("/api/config").then((r) => r.json());
    const list: ConfigSchemaView[] = res.schemas ?? [];
    setSchemas(list);
    setActive((cur) => cur || list[0]?.namespace || "");
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const current = schemas.find((s) => s.namespace === active);
  const Custom = current?.customComponent ? CUSTOM_TABS[current.customComponent] : undefined;

  return (
    <div className="flex h-full text-sm">
      <nav className="w-44 shrink-0 overflow-auto border-r border-white/10 bg-white/[0.02] p-2">
        <h2 className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-white/40">Settings</h2>
        {schemas.map((s) => (
          <button
            key={s.namespace}
            onClick={() => setActive(s.namespace)}
            className={`mt-0.5 block w-full truncate rounded px-2 py-1.5 text-left text-xs transition-colors ${
              active === s.namespace ? "bg-white/15 text-white" : "text-white/70 hover:bg-white/10"
            }`}
          >
            {s.title}
          </button>
        ))}
      </nav>

      <div className="flex flex-1 flex-col overflow-hidden p-5">
        {current ? (
          <>
            <h3 className="mb-3 shrink-0 text-base font-semibold">{current.title}</h3>
            <div className="min-h-0 flex-1 overflow-auto">
              {Custom ? <Custom /> : <ConfigForm key={current.namespace} schema={current} onSaved={load} />}
            </div>
          </>
        ) : (
          schemas.length === 0 && <p className="text-xs text-white/40">Loading…</p>
        )}
      </div>
    </div>
  );
}
