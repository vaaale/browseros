"use client";

import { useCallback, useEffect, useState } from "react";
import { AutoSaveStatus } from "./AutoSaveStatus";
import { useAutoSave, type AutoSaveStatus as AutoSaveStatusValue } from "./hooks/useAutoSave";

interface DefaultAgent {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
}

interface Patch {
  body?: string;
  description?: string;
}

// Editor for the shared default prompt (data/agents/default_agent/AGENT.md).
// Its body is prepended to any agent whose useDefaultPrompt is true. Not a
// runnable agent — managed via a dedicated endpoint (see /api/assistant/default-agent).
export function DefaultAgentTab() {
  const [agent, setAgent] = useState<DefaultAgent | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/assistant/default-agent").then((r) => r.json());
      setAgent(res.agent);
    } catch { /* keep previous state */ }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const savePatch = useCallback(async (patch: Patch) => {
    const res = await fetch("/api/assistant/default-agent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error || `Failed to update default agent (${res.status})`);
    }
    // Broadcast so open Copilot providers pick up the new prompt on next turn.
    window.dispatchEvent(new CustomEvent("bos:agent-updated"));
  }, []);

  const descSave = useAutoSave<Patch>(savePatch);
  const bodySave = useAutoSave<Patch>(savePatch);

  const combined = mergeStatus(descSave.status, bodySave.status);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-2">
        <p className="text-[11px] text-white/50">
          Prepended to any agent whose &quot;Use default prompt&quot; toggle is on.
        </p>
        <AutoSaveStatus status={combined} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {agent ? (
          <>
            <DescriptionField
              key={`desc-${agent.id}`}
              initial={agent.description}
              onSave={(value) => descSave.save({ description: value })}
            />
            <BodyField
              key={`body-${agent.id}`}
              initial={agent.systemPrompt}
              onSave={(value) => bodySave.save({ body: value })}
            />
          </>
        ) : (
          <p className="text-xs text-white/40">Loading…</p>
        )}
      </div>
    </div>
  );
}

function DescriptionField({ initial, onSave }: { initial: string; onSave: (value: string) => void }) {
  const [draft, setDraft] = useState(initial);
  return (
    <div className="mb-5">
      <div className="mb-2 text-xs font-semibold text-white">Description</div>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft !== initial) onSave(draft); }}
        className="w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white outline-none transition-colors focus:border-white/30"
      />
      <div className="mt-1.5 text-[11px] leading-snug text-white/50">
        Short summary shown alongside the default prompt in Settings.
      </div>
    </div>
  );
}

function BodyField({ initial, onSave }: { initial: string; onSave: (value: string) => void }) {
  const [draft, setDraft] = useState(initial);
  return (
    <div className="mb-5">
      <div className="mb-2 text-xs font-semibold text-white">Default Prompt</div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft !== initial) onSave(draft); }}
        className="w-full resize-y rounded border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-xs leading-relaxed text-white outline-none transition-colors focus:border-white/30"
        style={{ minHeight: "360px" }}
      />
      <div className="mt-1.5 text-[11px] leading-snug text-white/50">
        Shared operating policy. Changes take effect on the next model turn for any agent whose &quot;Use default prompt&quot; toggle is on.
      </div>
    </div>
  );
}

function mergeStatus(...values: AutoSaveStatusValue[]): AutoSaveStatusValue {
  if (values.some((v) => v === "error")) return "error";
  if (values.some((v) => v === "saving")) return "saving";
  if (values.some((v) => v === "saved")) return "saved";
  return "idle";
}