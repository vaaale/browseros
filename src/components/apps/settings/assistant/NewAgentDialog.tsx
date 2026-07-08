"use client";

import { useState } from "react";

export interface NewAgentDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the new agent's id after successful creation. */
  onCreated: (id: string) => void;
}

const DEFAULT_PROMPT = "You are a helpful BrowserOS assistant.";

/**
 * Modal that captures Name / Description / initial System Prompt and POSTs to
 * /api/subagents (createSubAgent). The caller selects the created agent.
 * The form is only mounted when `open` is true, so each opening starts fresh
 * without a state-resetting effect.
 */
export function NewAgentDialog({ open, onClose, onCreated }: NewAgentDialogProps) {
  if (!open) return null;
  return <NewAgentDialogInner onClose={onClose} onCreated={onCreated} />;
}

function NewAgentDialogInner({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_PROMPT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0 && systemPrompt.trim().length > 0 && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/subagents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          systemPrompt: systemPrompt.trim(),
          type: "local",
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { subAgent?: { id: string }; error?: string };
      if (!res.ok || !data.subAgent) {
        throw new Error(data.error || `Create failed (${res.status})`);
      }
      onCreated(data.subAgent.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200000] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[460px] max-w-[92vw] rounded-2xl border border-white/10 bg-[#15171e] p-6 text-sm shadow-2xl">
        <h2 className="mb-1 text-base font-semibold">New Agent</h2>
        <p className="mb-4 text-xs text-white/50">
          Create a new agent personality. You can refine its capabilities after it&apos;s created.
        </p>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-white/60">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Researcher"
              autoFocus
              className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-white/60">Description</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short summary shown in the agent list."
              className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs outline-none focus:border-white/30"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-white/60">System Prompt</label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={6}
              spellCheck={false}
              className="w-full resize-none rounded border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] leading-relaxed outline-none focus:border-white/30"
            />
          </div>
        </div>

        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded px-3 py-1.5 text-xs text-white/60 hover:bg-white/10 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="rounded bg-violet-500/30 px-4 py-1.5 text-xs font-medium text-violet-100 hover:bg-violet-500/40 disabled:opacity-40"
          >
            {saving ? "Creating…" : "Create Agent"}
          </button>
        </div>
      </div>
    </div>
  );
}
