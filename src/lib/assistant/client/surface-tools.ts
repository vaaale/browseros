"use client";

// Registry of runtime (Tier 2) surface tools contributed by mounted app
// windows (013-build-studio-agentic V2). Each open window registers its own
// declaration+handler pairs; the union of every currently-registered window's
// declarations rides on the NEXT run's `surfaceTools` (see run-client.ts), and
// a call is dispatched to whichever window most recently registered that name.
// Tools vanish the instant a window unregisters (unmount), so a closed app's
// tools are never offered to a new run.
//
// Framework-free apart from the "use client" boundary — no dependency on
// run-client.ts, so this module owns the surface-tool contract without a
// circular import (run-client depends on this module, not the reverse).

import type { ToolDeclaration } from "../tools";

export type FrontendToolHandler = (
  input: Record<string, unknown>,
  ctx: { signal: AbortSignal },
) => Promise<unknown>;

export interface SurfaceTool {
  declaration: ToolDeclaration;
  handler: FrontendToolHandler;
}

const windowTools = new Map<string, SurfaceTool[]>();

// Notified whenever the registered set changes, so run-client.ts can push the
// updated declarations to any run it's currently attached to — otherwise a
// window opened DURING a run (e.g. ui_preview_open, then wanting
// ui_preview_render in the same turn) would only gain its tools on the
// conversation's NEXT run, since surfaceTools is otherwise a send-time snapshot.
type ChangeListener = () => void;
const changeListeners = new Set<ChangeListener>();

export function onSurfaceToolsChanged(cb: ChangeListener): () => void {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

function notifyChanged(): void {
  for (const cb of changeListeners) cb();
}

/** Register a mounted app window's surface tools, replacing any it previously
 *  registered. Returns an unregister function (also call this on unmount). */
export function registerAppSurfaceTools(windowId: string, tools: SurfaceTool[]): () => void {
  if (tools.length === 0) {
    windowTools.delete(windowId);
    notifyChanged();
    return () => {};
  }
  windowTools.set(windowId, tools);
  notifyChanged();
  return () => unregisterAppSurfaceTools(windowId);
}

export function unregisterAppSurfaceTools(windowId: string): void {
  if (!windowTools.delete(windowId)) return;
  notifyChanged();
}

/** The union of every currently-registered window's tool declarations, for
 *  the next run's `surfaceTools`. Later-registered windows win name clashes. */
export function getActiveSurfaceToolDeclarations(): ToolDeclaration[] {
  const byName = new Map<string, ToolDeclaration>();
  for (const tools of windowTools.values()) {
    for (const t of tools) byName.set(t.declaration.name, t.declaration);
  }
  return [...byName.values()];
}

/** Look up the bound handler for a surface-tool call by name (searches every
 *  mounted window's tools). Used by the run-client dispatcher alongside the
 *  always-on global frontend-tool handlers. */
export function findSurfaceToolHandler(name: string): FrontendToolHandler | undefined {
  for (const tools of windowTools.values()) {
    const hit = tools.find((t) => t.declaration.name === name);
    if (hit) return hit.handler;
  }
  return undefined;
}
