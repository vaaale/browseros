"use client";

import { useEffect, useRef, useState } from "react";

export interface InstructionsSectionProps {
  systemPrompt: string;
  onSave: (value: string) => void;
}

export function InstructionsSection({ systemPrompt, onSave }: InstructionsSectionProps) {
  const [draft, setDraft] = useState(systemPrompt);
  const ref = useRef<HTMLTextAreaElement>(null);

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  // Re-size whenever the agent switches (parent re-keys, so systemPrompt is fresh).
  useEffect(() => {
    if (ref.current) autoResize(ref.current);
  }, [systemPrompt]);

  return (
    <div className="mb-5">
      <div className="mb-2 text-xs font-semibold text-white">
        System Prompt / Personality Instructions
      </div>
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          autoResize(e.target);
        }}
        onBlur={() => {
          if (draft !== systemPrompt) onSave(draft);
        }}
        className="w-full resize-y rounded border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-xs leading-relaxed text-white outline-none transition-colors focus:border-white/30"
        style={{ minHeight: "200px" }}
      />
      <div className="mt-1.5 text-[11px] leading-snug text-white/50">
        These instructions define the agent&apos;s behavior, tone, and capabilities.
        Changes take effect immediately for new conversations.
      </div>
    </div>
  );
}
