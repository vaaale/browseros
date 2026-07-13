"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { A2UIProvider, A2UIRenderer, useA2UI } from "@copilotkit/a2ui-renderer";
import type { AppProps } from "@/components/apps/types";
import { registerAppSurfaceTools } from "@/lib/assistant/client/surface-tools";
import { registerSurfaceAgent } from "@/lib/assistant/client/surface-agents";
import { uiPreviewSurfaceTools } from "./agent-tools-v2";
import { bosA2UICatalog } from "./catalog";

// 025-agent-delegation-v2 (Example 2, US-4): a distinct, focused prompt for
// the surface agent itself. Its two tools each generate AND render in one call
// (025-ui-preview-a2ui-tools), so it never has to remember a separate push step.
const GENERATIVE_UI_AGENT_PROMPT =
  "You are a specialist in designing and iterating on UI mockups for BrowserOS apps, working inside an already-open UI Preview window. To create a new mockup (or start over), call ui_preview_generate with a natural-language description — it generates and renders it in one step. To change the mockup that is already showing, call ui_preview_patch with a description of just the change (add/replace/remove an element); it reads the current mockup itself, so don't restate the whole design. Keep iterating until the mockup matches what was asked for, then summarize what you built in plain text.";

// Design-time A2UI surface host (013-build-studio-agentic V2). The Build
// Studio agent opens this window during the UI-design phase of a bos-app
// session and iterates a mockup on it via `ui_preview_generate`/
// `ui_preview_patch`, and the user watches it evolve. This is a design surface
// only — the Developer later implements the real app as React components;
// nothing here is ever shipped.

const DEFAULT_SURFACE_ID = "dynamic-surface";
const MAX_HISTORY = 20;

interface HistoryEntry {
  at: number;
  summary: string;
}

function UIPreviewSurface({ windowId }: { windowId: string }) {
  const { processMessages, getSurface } = useA2UI();
  const [surfaceId, setSurfaceId] = useState(DEFAULT_SURFACE_ID);
  const [activeRequirement, setActiveRequirement] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [notes, setNotes] = useState("");

  const onRender = useCallback(
    (id: string, operations: Record<string, unknown>[]) => {
      setSurfaceId(id);
      processMessages(operations);
      setHistory((prev) => [...prev, { at: Date.now(), summary: `${operations.length} op(s) on "${id}"` }].slice(-MAX_HISTORY));
    },
    [processMessages],
  );

  const onShowRequirement = useCallback((requirementId: string) => {
    if (requirementId) setActiveRequirement(requirementId);
  }, []);

  // Serialize the current live surface into the `{ id, component, ...props }`
  // operation shape so ui_preview_patch can hand the sub-agent the real
  // component tree (real ids) rather than a prose description of it.
  const getCurrentSurface = useCallback(() => {
    const surface = getSurface(surfaceId);
    const components: Record<string, unknown>[] = [];
    const entries = surface?.componentsModel?.entries as IterableIterator<[string, { id: string; type: string; properties?: Record<string, unknown> }]> | undefined;
    if (entries) {
      for (const [, cm] of entries) {
        components.push({ id: cm.id, component: cm.type, ...(cm.properties ?? {}) });
      }
    }
    return { surfaceId, components };
  }, [getSurface, surfaceId]);

  const tools = useMemo(
    () => uiPreviewSurfaceTools({ onRender, onShowRequirement, getCurrentSurface }),
    [onRender, onShowRequirement, getCurrentSurface],
  );
  useEffect(() => registerAppSurfaceTools(windowId, tools), [windowId, tools]);

  // 025-agent-delegation-v2: register this window's surface agent — a delegate
  // persona scoped to this window's own generate/patch tools, discoverable via
  // find_agent/agent_list only while this window stays open.
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    void registerSurfaceAgent(windowId, {
      name: "Generative UI Agent",
      description: "Specialist in generating and iterating on live UI mockups in this UI Preview window.",
      systemPrompt: GENERATIVE_UI_AGENT_PROMPT,
      toolNames: ["ui_preview_generate", "ui_preview_patch"],
    }).then((unregister) => {
      if (cancelled) unregister();
      else cleanup = unregister;
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [windowId]);

  return (
    <div className="flex h-full text-sm" data-theme="dark">
      <div className="min-h-0 flex-1 overflow-auto bg-white/[0.02] p-4">
        <A2UIRenderer
          surfaceId={surfaceId}
          className="min-h-full"
          fallback={
            <p className="text-xs text-white/40">Waiting for the agent to render a design — ask it to start the UI design phase.</p>
          }
        />
      </div>
      <aside className="flex w-64 shrink-0 flex-col gap-3 overflow-hidden border-l border-white/10 p-3 text-xs">
        <div>
          <h3 className="mb-1 font-semibold uppercase tracking-wide text-white/40">Active requirement</h3>
          <p className="text-white/70">{activeRequirement || "—"}</p>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <h3 className="mb-1 font-semibold uppercase tracking-wide text-white/40">Iteration history</h3>
          {history.length === 0 ? (
            <p className="text-white/35">No renders yet.</p>
          ) : (
            <ul className="space-y-1">
              {[...history].reverse().map((h) => (
                <li key={h.at} className="text-white/60">
                  {new Date(h.at).toLocaleTimeString()} — {h.summary}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="shrink-0">
          <h3 className="mb-1 font-semibold uppercase tracking-wide text-white/40">Notes</h3>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Jot design notes for yourself…"
            className="h-20 w-full resize-none rounded border border-white/10 bg-black/30 p-1.5 text-white/80 outline-none focus:border-white/25"
          />
        </div>
      </aside>
    </div>
  );
}

export default function UIPreviewApp({ windowId }: AppProps) {
  return (
    <A2UIProvider catalog={bosA2UICatalog}>
      <UIPreviewSurface windowId={windowId} />
    </A2UIProvider>
  );
}
