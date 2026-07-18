"use client";

import type { VoiceStatus } from "@/lib/voice/types";

interface VoiceOverlayProps {
  status: VoiceStatus;
  className?: string;
}

const STATUS_CONFIG: Record<VoiceStatus, { label: string; color: string; pulse: boolean } | null> = {
  idle: null,
  dormant: { label: "Waiting for wake word…", color: "bg-white/30", pulse: false },
  awake: { label: "Listening…", color: "bg-emerald-400", pulse: true },
  listening: { label: "Recording…", color: "bg-blue-400", pulse: true },
  transcribing: { label: "Transcribing…", color: "bg-amber-400", pulse: true },
  thinking: { label: "Thinking…", color: "bg-amber-400", pulse: true },
  speaking: { label: "Speaking…", color: "bg-emerald-400", pulse: true },
  interrupting: { label: "Interrupted", color: "bg-rose-400", pulse: false },
};

export function VoiceOverlay({ status, className }: VoiceOverlayProps) {
  const cfg = STATUS_CONFIG[status];
  if (!cfg) return null;

  return (
    <div className={`flex items-center gap-1.5 rounded-full border border-white/10 bg-black/60 px-2.5 py-1 text-[11px] text-white/80 backdrop-blur-sm ${className ?? ""}`}>
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${cfg.color} ${cfg.pulse ? "animate-pulse" : ""}`}
      />
      {cfg.label}
    </div>
  );
}
