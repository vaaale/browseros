"use client";

import { DataFsTab } from "@/components/apps/settings/DataFsTab";

export function Step3DataIsolation() {
  return (
    <div className="space-y-4">
      <p className="text-xs text-white/50">
        Choose how BOS isolates data when previewing live code changes. Only methods compatible with your
        filesystem are selectable. The best available option is pre-selected. You can change this later in
        Settings → Data Isolation.
      </p>
      <DataFsTab />
    </div>
  );
}
