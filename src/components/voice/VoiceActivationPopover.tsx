"use client";

import { useEffect, useRef } from "react";
import type { VoiceConfig } from "@/lib/voice/types";

interface VoiceActivationPopoverProps {
  config: VoiceConfig | null;
  onConfigChange: (patch: Partial<VoiceConfig>) => void;
  onClose: () => void;
}

export function VoiceActivationPopover({ config, onConfigChange, onClose }: VoiceActivationPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  if (!config) return null;

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 mb-1 z-50 min-w-[220px] rounded-lg border border-white/15 bg-[#1a1a2e]/95 p-3 shadow-xl backdrop-blur-sm"
    >
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-white/40">Voice Activation</p>

      <div className="space-y-1.5">
        <label className="flex cursor-pointer items-center gap-2 text-xs text-white/80">
          <input
            type="radio"
            value="button"
            checked={config.activationMode === "button"}
            onChange={() => onConfigChange({ activationMode: "button" })}
            className="accent-[#5b8cff]"
          />
          Push to talk
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-white/80">
          <input
            type="radio"
            value="wake-word"
            checked={config.activationMode === "wake-word"}
            onChange={() => onConfigChange({ activationMode: "wake-word" })}
            className="accent-[#5b8cff]"
          />
          Always on (wake word)
        </label>
      </div>

      {config.activationMode === "wake-word" && (
        <>
          <div className="mt-2">
            <label className="mb-1 block text-[10px] text-white/50">Wake word</label>
            <input
              type="text"
              value={config.wakeWord}
              onChange={(e) => onConfigChange({ wakeWord: e.target.value })}
              className="w-full rounded border border-white/10 bg-white/[0.05] px-2 py-1 text-xs text-white/90 outline-none focus:border-white/20"
              placeholder="hey bos"
            />
          </div>
          <div className="mt-2">
            <label className="mb-1 block text-[10px] text-white/50">
              Awake window <span className="text-white/30">{((config.awakeTimeoutMs ?? 5000) / 1000).toFixed(0)}s</span>
            </label>
            <input
              type="range"
              min={2000}
              max={30000}
              step={1000}
              value={config.awakeTimeoutMs ?? 5000}
              onChange={(e) => onConfigChange({ awakeTimeoutMs: parseInt(e.target.value) })}
              className="w-full accent-[#5b8cff]"
            />
          </div>
        </>
      )}

      <div className="mt-3 border-t border-white/10 pt-2">
        <label className="flex cursor-pointer items-center gap-2 text-xs text-white/80">
          <input
            type="checkbox"
            checked={config.speakReplies !== false}
            onChange={(e) => onConfigChange({ speakReplies: e.target.checked })}
            className="accent-[#5b8cff]"
          />
          Speak replies aloud
        </label>
      </div>

      <div className="mt-2 border-t border-white/10 pt-2">
        <label className="mb-1 block text-[10px] text-white/50">
          Speech threshold <span className="text-white/30">{config.vadThreshold.toFixed(2)} — higher = stricter</span>
        </label>
        <input
          type="range"
          min={0.1}
          max={0.95}
          step={0.05}
          value={config.vadThreshold}
          onChange={(e) => onConfigChange({ vadThreshold: parseFloat(e.target.value) })}
          className="w-full accent-[#5b8cff]"
        />
      </div>
    </div>
  );
}
