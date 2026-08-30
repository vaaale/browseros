"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { X, Check } from "lucide-react";
import { AppIcon } from "@/components/desktop/icons";

export interface UiHandlerOption {
  handlerId: string;
  displayName: string;
  description?: string;
  icon?: string;
  ownerId: string;
}

// The "Open with…" selection dialog (FR-016, US6) — shown only when >1 UI
// handler is registered for a type and no default is set. Portalled to
// document.body (style-guide.md §4 — window chrome is CSS-transformed, which
// makes it the containing block for position:fixed otherwise).
export function HandlerDialog({
  eventType,
  options,
  onCancel,
  onConfirm,
}: {
  eventType: string;
  options: UiHandlerOption[];
  onCancel: () => void;
  onConfirm: (handlerId: string, alwaysUse: boolean) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [alwaysUse, setAlwaysUse] = useState(false);
  const selectedOption = options.find((o) => o.handlerId === selected);

  return createPortal(
    <div className="fixed inset-0 z-[200000] flex items-center justify-center bg-black/60 backdrop-blur-sm" data-testid="handler-dialog">
      <div className="w-[420px] max-w-[92vw] rounded-2xl border border-white/10 bg-[#15171e] p-5 shadow-2xl">
        <div className="mb-1 flex items-start justify-between">
          <h3 className="text-sm font-semibold text-white">Open with…</h3>
          <button type="button" onClick={onCancel} className="rounded p-1 text-white/50 transition-colors hover:bg-white/10 hover:text-white">
            <X size={14} />
          </button>
        </div>
        <p className="mb-3.5 truncate font-mono text-[11px] text-white/40">{eventType}</p>
        <div className="flex flex-col gap-1.5">
          {options.map((opt) => (
            <button
              key={opt.handlerId}
              type="button"
              data-testid={`handler-option-${opt.handlerId}`}
              onClick={() => setSelected(opt.handlerId)}
              className={`flex w-full items-center gap-3 rounded-lg border px-2.5 py-2.5 text-left transition-colors hover:bg-white/5 ${
                selected === opt.handlerId ? "border-white/30 bg-white/10" : "border-white/10"
              }`}
            >
              <span
                className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
                  selected === opt.handlerId ? "border-white/60" : "border-white/30"
                }`}
              >
                {selected === opt.handlerId && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
              </span>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/5 text-white/70">
                <AppIcon name={opt.icon || "Puzzle"} size={15} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-white/90">{opt.displayName}</span>
                <span className="block truncate text-[11px] text-white/40">{opt.description ?? opt.ownerId}</span>
              </span>
            </button>
          ))}
        </div>
        <label
          className={`mt-3.5 flex items-center gap-2.5 rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 ${
            selected ? "cursor-pointer" : "cursor-default opacity-50"
          }`}
        >
          <input
            type="checkbox"
            className="sr-only"
            disabled={!selected}
            checked={alwaysUse}
            onChange={(e) => setAlwaysUse(e.target.checked)}
          />
          <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded ${alwaysUse ? "bg-white" : "border border-white/30"}`}>
            {alwaysUse && <Check size={10} className="text-black" />}
          </span>
          <span className="text-xs text-white/60">
            {selectedOption ? `Always open ${selectedOption.displayName} for this event type` : "Always open with this app for this event type"}
          </span>
        </label>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20">
            Cancel
          </button>
          <button
            type="button"
            disabled={!selected}
            data-testid="handler-dialog-confirm"
            onClick={() => selected && onConfirm(selected, alwaysUse)}
            className="rounded bg-violet-500/40 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-violet-500/55 disabled:opacity-40"
          >
            {selectedOption ? `Open in ${selectedOption.displayName}` : "Choose an app"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
