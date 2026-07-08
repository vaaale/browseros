"use client";

import { useState } from "react";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import type { AutoSaveStatus as AutoSaveStatusValue } from "./hooks/useAutoSave";

export interface AutoSaveStatusProps {
  status: AutoSaveStatusValue;
  className?: string;
}

/**
 * Right-side header indicator for the agent-details pane. Mirrors the mockup:
 * emerald "Saved" that fades out ~2s after success, transient "Saving…", and
 * a red error state that stays until the next save attempt.
 */
export function AutoSaveStatus({ status, className }: AutoSaveStatusProps) {
  // Retain the last non-idle status so the label keeps its text while it fades.
  const [shown, setShown] = useState<Exclude<AutoSaveStatusValue, "idle">>("saved");
  const [prevStatus, setPrevStatus] = useState<AutoSaveStatusValue>(status);
  if (status !== prevStatus) {
    setPrevStatus(status);
    if (status !== "idle") setShown(status);
  }

  const visible = status !== "idle";

  const label = shown === "saving" ? "Saving…" : shown === "error" ? "Error" : "Saved";
  const color =
    shown === "saved" ? "text-emerald-400" : shown === "error" ? "text-red-400" : "text-white/60";
  const Icon = shown === "saving" ? Loader2 : shown === "error" ? AlertCircle : Check;

  return (
    <span
      aria-live="polite"
      aria-hidden={!visible}
      className={`inline-flex items-center gap-1 text-[11px] font-medium tabular-nums transition-opacity duration-300 ${color} ${
        visible ? "opacity-100" : "opacity-0"
      } ${className ?? ""}`}
    >
      <Icon size={12} className={shown === "saving" ? "animate-spin" : ""} />
      {label}
    </span>
  );
}
