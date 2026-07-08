"use client";

import { Lock } from "lucide-react";

/**
 * Tri-state scope toggle per spec.md §Scope Override UI Logic:
 *
 *   granted + not-overridden → toggle-on
 *   granted + override=false → toggle-off
 *   not granted              → locked (cannot be forced on)
 *
 * The parent (`ServiceConfigView`) owns state and passes an onChange. This
 * component is purely presentational and cannot flip a locked scope on.
 */
export interface ScopeToggleProps {
  scope: string;
  label: string;
  granted: boolean;
  enabled: boolean;
  onChange: (next: boolean) => void;
}

export function ScopeToggle({ scope, label, granted, enabled, onChange }: ScopeToggleProps) {
  const disabled = !granted;
  const state = disabled ? "locked" : enabled ? "on" : "off";

  return (
    <div className="flex items-center justify-between rounded border border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="min-w-0 flex-1 pr-3">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-white/90">
          {label}
          {disabled && <Lock size={11} className="text-white/40" />}
        </div>
        <div className="mt-0.5 truncate font-mono text-[10px] text-white/40" title={scope}>
          {scope}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={state === "on"}
        aria-disabled={disabled}
        onClick={() => !disabled && onChange(!enabled)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          state === "on"
            ? "bg-violet-500"
            : state === "off"
            ? "bg-white/15"
            : "bg-white/10 opacity-50 cursor-not-allowed"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
            state === "on" ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}
