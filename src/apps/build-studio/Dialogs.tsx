"use client";

// Small, self-contained modal primitives for Build Studio's Project/file
// context-menu actions (037-project-layer, Phase 4): a styled confirm
// (Discard/Delete) and a styled single-line input (Activate's branch name,
// Rename's new name) — full-screen overlay + centered card, matching the
// existing styled-dialog pattern already used in GitRemotesTab.tsx, rather
// than native window.confirm/window.prompt.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Windows are positioned with a CSS `transform` (Window.tsx), which makes
// them the containing block for any `position: fixed` descendant — so a
// naive `fixed inset-0`/`fixed left/top` here would resolve against the
// window's own bounds instead of the real viewport (the menu/dialog appears
// offset by the window's position, not at the click point). Portal to
// document.body, same fix already used for exactly this in scheduler/index.tsx.

function Overlay({ children, onDismiss }: { children: React.ReactNode; onDismiss: () => void }) {
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div className="w-80 rounded-lg border border-white/10 bg-[#161821] p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  danger = true,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Overlay onDismiss={onCancel}>
      <h3 className="mb-1.5 text-sm font-semibold text-white/90">{title}</h3>
      <p className="mb-4 text-xs text-white/60">{message}</p>
      <div className="flex justify-end gap-2">
        <button disabled={busy} onClick={onCancel} className="rounded px-3 py-1.5 text-xs text-white/60 hover:bg-white/10 disabled:opacity-50">
          Cancel
        </button>
        <button
          disabled={busy}
          onClick={onConfirm}
          className={`rounded px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
            danger ? "bg-red-500/25 text-red-200 hover:bg-red-500/40" : "bg-emerald-500/25 text-emerald-200 hover:bg-emerald-500/40"
          }`}
        >
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </Overlay>
  );
}

export function PromptDialog({
  title,
  message,
  initialValue = "",
  prefix,
  confirmLabel = "Create",
  busy = false,
  error,
  choices,
  choiceLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  message?: string;
  initialValue?: string;
  /** A fixed, non-editable prefix rendered before the input (e.g. "alpha/"). */
  prefix?: string;
  confirmLabel?: string;
  busy?: boolean;
  error?: string;
  /** An optional single-choice list above the input. Generic on purpose: the
   *  dialog does not know what a choice MEANS, only that the caller needs one
   *  alongside the name. The first entry is preselected. */
  choices?: Array<{ id: string; label: string; hint?: string }>;
  choiceLabel?: string;
  onConfirm: (value: string, choiceId?: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [choice, setChoice] = useState(() => choices?.[0]?.id ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Deferred a tick: this dialog mounts via a portal in direct response to
    // a context-menu click that closes the previous portal in the same
    // event — focusing synchronously in that commit's passive effects can
    // trigger React's "flushSync was called from inside a lifecycle method"
    // warning (focus dispatches synthetic focus/blur events that themselves
    // want to flush while React is still finishing this one).
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, []);
  const submit = () => {
    if (!value.trim() || busy) return;
    if (choices?.length && !choice) return;
    onConfirm(value.trim(), choices?.length ? choice : undefined);
  };
  return (
    <Overlay onDismiss={onCancel}>
      <h3 className="mb-1.5 text-sm font-semibold text-white/90">{title}</h3>
      {message && <p className="mb-2 text-xs text-white/60">{message}</p>}
      {!!choices?.length && (
        <div className="mb-3">
          {choiceLabel && <div className="mb-1 text-[11px] uppercase tracking-wide text-white/40">{choiceLabel}</div>}
          <div className="max-h-52 space-y-0.5 overflow-auto">
            {choices.map((c) => (
              <label
                key={c.id}
                className={`flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-xs ${
                  choice === c.id ? "bg-white/10 text-white/85" : "text-white/60 hover:bg-white/5"
                }`}
              >
                <input type="radio" className="mt-0.5" checked={choice === c.id} disabled={busy} onChange={() => setChoice(c.id)} />
                <span className="min-w-0">
                  <span className="block">{c.label}</span>
                  {c.hint && <span className="block text-[10px] leading-snug text-white/35">{c.hint}</span>}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="mb-1 flex items-center rounded border border-white/10 bg-black/30 px-2 py-1.5 focus-within:border-white/25">
        {prefix && <span className="shrink-0 text-xs text-white/40">{prefix}</span>}
        <input
          ref={inputRef}
          data-testid="prompt-dialog-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onCancel();
          }}
          disabled={busy}
          spellCheck={false}
          className="w-full min-w-0 bg-transparent text-xs text-white/85 outline-none disabled:opacity-50"
        />
      </div>
      {error && <p className="mb-2 text-[11px] text-red-400">{error}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button disabled={busy} onClick={onCancel} className="rounded px-3 py-1.5 text-xs text-white/60 hover:bg-white/10 disabled:opacity-50">
          Cancel
        </button>
        <button
          disabled={busy || !value.trim()}
          onClick={submit}
          className="rounded bg-sky-500/25 px-3 py-1.5 text-xs font-medium text-sky-200 hover:bg-sky-500/40 disabled:opacity-50"
        >
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </Overlay>
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Why this item is disabled. A greyed-out action with no reason is its own
   *  small mystery — the user cannot tell "not allowed here" from "broken", and
   *  the one thing they need (pick a branch) is not guessable from the label. */
  hint?: string;
  /** Renders a submenu instead of being directly selectable (e.g. "Push feature branch" -> one item per remote). */
  submenu?: MenuItem[];
}

/** Position-tracked right-click menu, dismissed on outside click/Escape/re-right-click
 *  — same shell pattern as useLogContextMenu / the Files app's context menu. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [openSubmenu, setOpenSubmenu] = useState<number | null>(null);
  // Once per menu, not once per item: several disabled actions usually share
  // ONE cause ("no feature branch"), and repeating it under each of them reads
  // like several different problems.
  const hints = [...new Set(items.filter((i) => i.disabled && i.hint).map((i) => i.hint as string))];

  useEffect(() => {
    const onDocEvent = (e: Event) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDocEvent);
    document.addEventListener("contextmenu", onDocEvent);
    document.addEventListener("scroll", onDocEvent, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocEvent);
      document.removeEventListener("contextmenu", onDocEvent);
      document.removeEventListener("scroll", onDocEvent, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      style={{ position: "fixed", left: x, top: y, zIndex: 60 }}
      className="min-w-[180px] rounded-md border border-white/10 bg-[#1b1d27] py-1 text-xs shadow-xl"
    >
      {items.map((item, i) => (
        <div key={item.label} className="relative">
          <button
            disabled={item.disabled}
            onClick={() => {
              if (item.submenu) {
                setOpenSubmenu(openSubmenu === i ? null : i);
                return;
              }
              item.onSelect();
              onClose();
            }}
            className={`flex w-full items-center justify-between px-3 py-1.5 text-left disabled:opacity-40 ${
              item.danger ? "text-red-300 hover:bg-red-500/15" : "text-white/80 hover:bg-white/10"
            }`}
          >
            <span>{item.label}</span>
            {item.submenu && <span className="text-white/40">▸</span>}
          </button>
          {item.submenu && openSubmenu === i && (
            <div className="absolute left-full top-0 min-w-[160px] rounded-md border border-white/10 bg-[#1b1d27] py-1 shadow-xl">
              {item.submenu.length === 0 ? (
                <p className="px-3 py-1.5 text-white/40">None configured</p>
              ) : (
                item.submenu.map((sub) => (
                  <button
                    key={sub.label}
                    disabled={sub.disabled}
                    onClick={() => {
                      sub.onSelect();
                      onClose();
                    }}
                    className="flex w-full items-center px-3 py-1.5 text-left text-white/80 hover:bg-white/10 disabled:opacity-40"
                  >
                    {sub.label}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      ))}
      {hints.map((h) => (
        <p key={h} className="mt-1 border-t border-white/10 px-3 pb-0.5 pt-1.5 text-[10px] leading-snug text-white/40">
          {h}
        </p>
      ))}
    </div>,
    document.body,
  );
}
