"use client";

import { useState } from "react";

export interface InstructionsSectionProps {
  systemPrompt: string;
  onSave: (value: string) => void;
}

/**
 * System-prompt editor for the selected agent. Blur commits through the parent
 * auto-save hook, matching the mockup's `.instructions-section` (label +
 * monospace textarea + helper text).
 */
export function InstructionsSection({ systemPrompt, onSave }: InstructionsSectionProps) {
  // The parent re-keys on agent.id so the initial state is correct on each
  // agent switch — no sync effect needed.
  const [draft, setDraft] = useState(systemPrompt);

  return (
    // Flex column that fills the remaining height of the Instructions tab; the
    // textarea (flex-1) grows to use it, with a 160px floor and manual resize.
    <div className="mb-5 flex min-h-0 flex-1 flex-col">
      <div className="mb-2 shrink-0 text-xs font-semibold text-white">
        System Prompt / Personality Instructions
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== systemPrompt) onSave(draft);
        }}
        className="min-h-0 w-full flex-1 resize-y rounded border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-xs leading-relaxed text-white outline-none transition-colors focus:border-white/30"
        style={{ minHeight: "160px" }}
      />
      <div className="mt-1.5 shrink-0 text-[11px] leading-snug text-white/50">
        These instructions define the agent&apos;s behavior, tone, and capabilities.
        Changes take effect immediately for new conversations.
      </div>
    </div>
  );
}
