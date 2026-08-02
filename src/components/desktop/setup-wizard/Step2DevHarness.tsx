"use client";

import { DevHarnessTab } from "@/components/apps/settings/DevHarnessTab";

export function Step2DevHarness() {
  return (
    <div className="space-y-4">
      <p className="text-xs text-white/50">
        Configure the headless Dev Harness (Claude Code or OpenCode) used for agentic development tasks.
        Use the <strong className="text-white/70">Save</strong> button inside the panel to persist your settings.
        You can skip this step and configure it later in Settings → Dev Harness.
      </p>
      <div className="rounded border border-white/10 p-4">
        <DevHarnessTab />
      </div>
    </div>
  );
}
