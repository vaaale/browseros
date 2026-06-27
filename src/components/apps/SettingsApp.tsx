"use client";

import { useCallback, useEffect, useState } from "react";
import type { ConfigSchemaView } from "@/lib/config/types";
import { AppearanceTab } from "./settings/AppearanceTab";
import { AssistantTab } from "./settings/AssistantTab";
import { SkillsTab } from "./settings/SkillsTab";
import { AppsTab } from "./settings/AppsTab";
import { DevHarnessTab } from "./settings/DevHarnessTab";
import { DataFsTab } from "./settings/DataFsTab";
import { VersionsTab } from "./settings/VersionsTab";
import { ConfigForm } from "./settings/ConfigForm";
import { ProviderSettings } from "./ProviderSettings";
import type { AppProps } from "./types";

// Custom tab components keyed by ConfigSchema.customComponent.
const CUSTOM_TABS: Record<string, React.ComponentType> = {
  appearance: AppearanceTab,
  "ai-provider": ProviderSettings,
  assistant: AssistantTab,
  skills: SkillsTab,
  apps: AppsTab,
  "dev-harness": DevHarnessTab,
  datafs: DataFsTab,
  "self-modification": VersionsTab,
};

export function SettingsApp(_props: AppProps) {
  const [schemas, setSchemas] = useState<ConfigSchemaView[]>([]);
  const [active, setActive] = useState<string>("");

  const load = useCallback(async () => {
    const res = await fetch("/api/config").then((r) => r.json());
    const list: ConfigSchemaView[] = res.schemas ?? [];
    setSchemas(list);
    setActive((cur) => cur || list[0]?.namespace || "");
  }, []);

  useEffect(() => {
    load();
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

      <div className="flex-1 overflow-auto p-5">
        {current && (
          <>
            <h3 className="mb-3 text-base font-semibold">{current.title}</h3>
            {Custom ? <Custom /> : <ConfigForm key={current.namespace} schema={current} onSaved={load} />}
          </>
        )}
        {schemas.length === 0 && <p className="text-xs text-white/40">Loading…</p>}
      </div>
    </div>
  );
}
