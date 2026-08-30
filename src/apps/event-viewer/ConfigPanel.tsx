"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check } from "lucide-react";
import { AppIcon } from "@/components/desktop/icons";
import type { HandlerGroup } from "./types";

// Configuration tab (FR-018): view all handlers grouped by event type,
// enable/disable headless handlers, set/clear the default UI handler.
export function ConfigPanel({ refreshKey }: { refreshKey: number }) {
  const [groups, setGroups] = useState<Record<string, HandlerGroup>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = (await fetch("/api/events/handlers").then((r) => r.json())) as Record<string, HandlerGroup>;
      setGroups(res ?? {});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, refreshKey]);

  const toggleHeadless = async (handlerId: string, ownerId: string, enabled: boolean) => {
    await fetch("/api/events/handlers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handlerId, ownerId, enabled }),
    });
    void load();
  };

  const setDefault = async (eventType: string, preferredHandlerId: string | null) => {
    await fetch("/api/events/preference", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventType, preferredHandlerId }),
    });
    void load();
  };

  const types = Object.keys(groups).sort();

  if (!loading && types.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-xs text-white/40" data-testid="config-empty">
        No handlers registered yet.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[680px] p-5" data-testid="config-panel">
      <h3 className="text-base font-semibold text-white">Event handler configuration</h3>
      <p className="mb-5 mt-1 text-xs text-white/50">
        Headless handlers are invoked by the core event service on emission. Disable one to stop it from processing
        (and blocking) its event types. UI handler defaults control which app opens when you click an event with
        multiple options.
      </p>
      {types.map((type) => {
        const group = groups[type];
        return (
          <div key={type} className="mb-5" data-testid={`config-group-${type}`}>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-white/50">
              <span>type</span>
              <span className="font-mono normal-case tracking-normal text-white/70">{type}</span>
              <span className="ml-auto text-[11px] font-normal normal-case text-white/25">
                {group.headless.length} headless · {group.ui.length} ui
              </span>
            </div>
            <div className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.02]">
              <div className="border-b border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-white/40">
                Headless handlers · invoked automatically on emission
              </div>
              {group.headless.length === 0 ? (
                <div className="p-3 text-[11px] text-white/35">None registered</div>
              ) : (
                group.headless.map((h) => (
                  <div
                    key={h.handlerId}
                    className={`flex items-center gap-3 border-t border-white/5 px-3 py-2.5 first:border-t-0 ${h.enabled ? "" : "opacity-45"}`}
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-400/10 text-sky-200">
                      <AppIcon name={h.icon || "Server"} size={15} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-semibold text-white/90">{h.displayName}</span>
                        <span className="rounded bg-sky-400/20 px-1.5 py-0.5 text-[10px] text-sky-200">headless</span>
                        {!h.enabled && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/40">disabled</span>}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-white/40">
                        timeout {Math.round(h.timeoutMs / 1000)}s · {h.ownerId}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      {h.recentFailures > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded border border-amber-400/25 bg-amber-400/10 px-1.5 py-0.5 text-[11px] text-amber-200">
                          <AlertTriangle size={11} /> {h.recentFailures} fail{h.recentFailures === 1 ? "" : "s"}
                        </span>
                      ) : (
                        <span className="text-[11px] text-white/25">0 failures</span>
                      )}
                      <button
                        type="button"
                        data-testid={`toggle-${h.handlerId}`}
                        onClick={() => void toggleHeadless(h.handlerId, h.ownerId, !h.enabled)}
                        className={`relative inline-flex h-[17px] w-[30px] shrink-0 items-center rounded-full transition-colors ${
                          h.enabled ? "bg-white/40" : "bg-white/15"
                        }`}
                      >
                        <span
                          className={`absolute h-[13px] w-[13px] rounded-full bg-white transition-transform ${
                            h.enabled ? "translate-x-[15px]" : "translate-x-[2px]"
                          }`}
                        />
                      </button>
                    </div>
                  </div>
                ))
              )}
              <div className="border-t border-b border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-white/40">
                UI handlers · launched when the user clicks an event
              </div>
              {group.ui.length === 0 ? (
                <div className="p-3 text-[11px] text-white/35">None — events of this type use the generic view</div>
              ) : (
                group.ui.map((u) => (
                  <div key={u.handlerId} className="flex items-center gap-3 border-t border-white/5 px-3 py-2.5 first:border-t-0">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-200">
                      <AppIcon name={u.icon || "Puzzle"} size={15} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-semibold text-white/90">{u.displayName}</span>
                        <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] text-violet-200">UI</span>
                        {u.isDefault && (
                          <span className="inline-flex items-center gap-1 rounded bg-white/15 px-1.5 py-0.5 text-[10px] text-white/90">
                            <Check size={10} /> default
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-white/40">{u.description ?? u.ownerId}</div>
                    </div>
                    <div className="shrink-0">
                      {u.isDefault ? (
                        <button
                          type="button"
                          data-testid={`clear-default-${u.handlerId}`}
                          onClick={() => void setDefault(type, null)}
                          className="rounded bg-white/10 px-2 py-1 text-[11px] hover:bg-white/20"
                        >
                          Clear
                        </button>
                      ) : (
                        <button
                          type="button"
                          data-testid={`set-default-${u.handlerId}`}
                          onClick={() => void setDefault(type, u.handlerId)}
                          className="rounded bg-white/10 px-2 py-1 text-[11px] hover:bg-white/20"
                        >
                          Set as default
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
