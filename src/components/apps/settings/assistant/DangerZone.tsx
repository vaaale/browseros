"use client";

import { useState } from "react";

export interface DangerZoneProps {
  agentId: string;
  agentName: string;
  /** Fired after the DELETE succeeds; parent typically resets selection and refetches. */
  onDeleted: () => void;
}

/**
 * Destructive-actions section at the bottom of the details pane. Rendered only
 * for non-protected agents (the caller hides it for the default assistant).
 * Uses window.confirm — spec calls out that the confirmation intentionally
 * matches the mockup's simple prompt rather than a custom modal.
 */
export function DangerZone({ agentId, agentName, onDeleted }: DangerZoneProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    const ok = window.confirm(
      `Are you sure you want to permanently delete the "${agentName}" agent? This cannot be undone.`,
    );
    if (!ok) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/subagents/${agentId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `Failed to delete agent (${res.status})`);
      }
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
      setDeleting(false);
    }
  };

  return (
    <div className="mt-8 border-t border-white/10 pt-4">
      <div className="mb-2 text-[11px] font-semibold text-orange-500">Danger Zone</div>
      <button
        type="button"
        onClick={handleDelete}
        disabled={deleting}
        className="rounded border border-orange-500/30 bg-transparent px-2.5 py-1.5 text-[11px] text-orange-500 transition-colors hover:border-orange-500/50 hover:bg-orange-500/10 disabled:opacity-50"
      >
        {deleting ? "Deleting…" : `Delete Agent "${agentName}"`}
      </button>
      <div className="mt-1.5 text-[11px] leading-snug text-white/50">
        This action cannot be undone. The agent will be permanently removed.
      </div>
      {error && (
        <div className="mt-2 text-[11px] text-red-400">{error}</div>
      )}
    </div>
  );
}
