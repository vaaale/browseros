"use client";

import { useState } from "react";

export interface DetailsHeaderProps {
  name: string;
  description: string;
  onSaveName: (value: string) => void;
  onSaveDescription: (value: string) => void;
}

/**
 * Top of the details pane: editable Name + Role Description. Both save on blur
 * via callbacks the parent wires to useAutoSave, matching the mockup layout
 * (`.details-header` above the instructions section).
 */
export function DetailsHeader({
  name,
  description,
  onSaveName,
  onSaveDescription,
}: DetailsHeaderProps) {
  // Local editable copies so typing doesn't fight the parent's authoritative
  // value; blur commits back through the save callback. The parent re-keys
  // this component on agent.id, so the initial state is correct for each
  // agent switch — no sync effect needed.
  const [nameDraft, setNameDraft] = useState(name);
  const [descDraft, setDescDraft] = useState(description);

  return (
    <div className="mb-5 border-b border-white/10 pb-4">
      <div className="mb-3.5">
        <label className="mb-1 block text-[11px] text-white/50" htmlFor="agent-name">
          Agent Name
        </label>
        <input
          id="agent-name"
          type="text"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={() => {
            if (nameDraft !== name) onSaveName(nameDraft);
          }}
          className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white outline-none transition-colors focus:border-white/30"
        />
      </div>
      <div className="mb-0">
        <label className="mb-1 block text-[11px] text-white/50" htmlFor="agent-desc">
          Role Description
        </label>
        <textarea
          id="agent-desc"
          value={descDraft}
          onChange={(e) => setDescDraft(e.target.value)}
          onBlur={() => {
            if (descDraft !== description) onSaveDescription(descDraft);
          }}
          className="w-full resize-y rounded border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-xs leading-relaxed text-white outline-none transition-colors focus:border-white/30"
          style={{ minHeight: "60px" }}
        />
      </div>
    </div>
  );
}
