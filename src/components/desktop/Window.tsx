"use client";

import { createElement, useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { Pin, PinOff } from "lucide-react";
import type { WindowBounds, WindowInstance } from "@/os/types";
import { useOSStore } from "@/store/os-provider";
import { getAppComponent } from "@/components/apps/registry";
import { IframeApp } from "@/components/apps/IframeApp";

const TOPBAR_H = 32;
// Higher than zCounter can plausibly reach in a session, so a pinned window can
// never be covered by focusing an unpinned one.
const PIN_Z_BAND = 1_000_000;
// Mirrors os-store's own resize() floor (it re-clamps regardless) — duplicated
// here because dragging the north/west edges must shrink width/height AND grow
// x/y in lockstep, and that lockstep math needs to know the same floor the
// store will apply, not just let the store clamp it after the fact.
const MIN_W = 280;
const MIN_H = 180;

type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export function Window({ win }: { win: WindowInstance }) {
  const focus = useOSStore((s) => s.focus);
  const close = useOSStore((s) => s.close);
  const minimize = useOSStore((s) => s.minimize);
  const toggleMaximize = useOSStore((s) => s.toggleMaximize);
  const togglePin = useOSStore((s) => s.togglePin);
  const move = useOSStore((s) => s.move);
  const resize = useOSStore((s) => s.resize);
  const focusedId = useOSStore((s) => s.focusedId);
  const manifest = useOSStore((s) => s.apps.find((a) => a.id === win.appId));

  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragState = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
    nextX: number;
    nextY: number;
    rafId: number | null;
  } | null>(null);
  const resizeState = useRef<{
    pointerId: number;
    dir: ResizeDir;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    startWinX: number;
    startWinY: number;
  } | null>(null);
  // Holds the exact end-handler reference passed to addEventListener, so the
  // handler can remove its OWN sibling listener (pointerup vs. pointercancel,
  // whichever didn't fire) via a ref read instead of referencing its own
  // `const` name — self-reference from within a useCallback body is flagged
  // by the React Compiler lint rule as an unsafe stale-closure pattern.
  const dragEndRef = useRef<() => void>(() => {});
  const resizeEndRef = useRef<() => void>(() => {});

  const applyDragFrame = useCallback(() => {
    const d = dragState.current;
    if (!d) return;
    d.rafId = null;
    const el = containerRef.current;
    if (el) {
      el.style.transform = `translate3d(${d.nextX}px, ${d.nextY}px, 0)`;
    }
  }, []);

  const onDragMove = useCallback(
    (e: PointerEvent) => {
      const d = dragState.current;
      if (!d || e.pointerId !== d.pointerId) return;
      // Mirror the clamping applied by the store's `move` action so the
      // imperative transform matches the final React-rendered position.
      d.nextX = Math.max(0, e.clientX - d.offsetX);
      d.nextY = Math.max(TOPBAR_H, e.clientY - d.offsetY);
      if (d.rafId === null) {
        d.rafId = requestAnimationFrame(applyDragFrame);
      }
    },
    [applyDragFrame],
  );

  const onDragEnd = useCallback(() => {
    const d = dragState.current;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", dragEndRef.current);
    window.removeEventListener("pointercancel", dragEndRef.current);
    if (!d) return;
    if (d.rafId !== null) {
      cancelAnimationFrame(d.rafId);
      d.rafId = null;
    }
    dragState.current = null;
    move(win.id, d.nextX, d.nextY);
  }, [move, onDragMove, win.id]);

  const startDrag = useCallback(
    (e: ReactPointerEvent) => {
      if (win.maximized) return;
      focus(win.id);
      dragState.current = {
        pointerId: e.pointerId,
        offsetX: e.clientX - win.x,
        offsetY: e.clientY - win.y,
        nextX: win.x,
        nextY: win.y,
        rafId: null,
      };
      dragEndRef.current = onDragEnd;
      // Captures the pointer to this element so pointermove/pointerup keep
      // firing here even when the cursor crosses an iframe's own document
      // (this window's app content, or another window's) mid-drag — without
      // it, fast movement over an iframe silently drops the move/up events,
      // leaving dragState stuck and the drag "resuming" on the next stray
      // pointermove that reaches window.
      e.currentTarget.setPointerCapture(e.pointerId);
      window.addEventListener("pointermove", onDragMove);
      window.addEventListener("pointerup", onDragEnd, { once: true });
      window.addEventListener("pointercancel", onDragEnd, { once: true });
    },
    [focus, onDragEnd, onDragMove, win.id, win.maximized, win.x, win.y],
  );

  const onResizeMove = useCallback(
    (e: PointerEvent) => {
      const r = resizeState.current;
      if (!r || e.pointerId !== r.pointerId) return;
      const dx = e.clientX - r.startX;
      const dy = e.clientY - r.startY;
      const bounds: Partial<WindowBounds> = {};
      if (r.dir.includes("e")) bounds.width = r.startW + dx;
      if (r.dir.includes("s")) bounds.height = r.startH + dy;
      // West/north also move x/y, and by exactly however much the size
      // actually changed (not the raw pointer delta) — once MIN_W/MIN_H
      // clamps the size, the edge must stop tracking the cursor too, or the
      // window visibly detaches from the pointer instead of just stopping.
      if (r.dir.includes("w")) {
        const w = Math.max(MIN_W, r.startW - dx);
        bounds.width = w;
        bounds.x = Math.max(0, r.startWinX + (r.startW - w));
      }
      if (r.dir.includes("n")) {
        const h = Math.max(MIN_H, r.startH - dy);
        bounds.height = h;
        bounds.y = Math.max(TOPBAR_H, r.startWinY + (r.startH - h));
      }
      resize(win.id, bounds);
    },
    [resize, win.id],
  );

  const onResizeEnd = useCallback(() => {
    resizeState.current = null;
    window.removeEventListener("pointermove", onResizeMove);
    window.removeEventListener("pointerup", resizeEndRef.current);
    window.removeEventListener("pointercancel", resizeEndRef.current);
  }, [onResizeMove]);

  const startResize = useCallback(
    (e: ReactPointerEvent, dir: ResizeDir) => {
      e.stopPropagation();
      focus(win.id);
      resizeState.current = {
        pointerId: e.pointerId,
        dir,
        startX: e.clientX,
        startY: e.clientY,
        startW: win.width,
        startH: win.height,
        startWinX: win.x,
        startWinY: win.y,
      };
      resizeEndRef.current = onResizeEnd;
      // See startDrag's comment — without pointer capture, dragging the
      // corner across this window's own iframe content drops pointermove and
      // (worse) pointerup, so the resize never ends and resumes on the next
      // pointermove that reaches window instead of a fresh pointerdown.
      e.currentTarget.setPointerCapture(e.pointerId);
      window.addEventListener("pointermove", onResizeMove);
      window.addEventListener("pointerup", onResizeEnd, { once: true });
      window.addEventListener("pointercancel", onResizeEnd, { once: true });
    },
    [focus, onResizeEnd, onResizeMove, win.height, win.id, win.width, win.x, win.y],
  );

  useEffect(() => {
    return () => {
      const d = dragState.current;
      if (d?.rafId != null) cancelAnimationFrame(d.rafId);
      window.removeEventListener("pointermove", onDragMove);
      window.removeEventListener("pointerup", onDragEnd);
      window.removeEventListener("pointercancel", onDragEnd);
      const r = resizeState.current;
      if (r) {
        window.removeEventListener("pointermove", onResizeMove);
        window.removeEventListener("pointerup", onResizeEnd);
        window.removeEventListener("pointercancel", onResizeEnd);
      }
    };
  }, [onDragEnd, onDragMove, onResizeEnd, onResizeMove]);

  if (win.minimized) return null;

  const AppComponent = getAppComponent(win.appId);
  const isFocused = focusedId === win.id;

  // Pinned windows live in a z-band above every unpinned one. Applied at render
  // instead of stored, so focus() keeps handing out plain incrementing values and
  // there is no stacking state to keep consistent.
  const z = win.zIndex + (win.alwaysOnTop ? PIN_Z_BAND : 0);

  const style: React.CSSProperties = win.maximized
    ? { top: TOPBAR_H + 8, left: 8, right: 8, bottom: 84, zIndex: z, willChange: "transform" }
    : {
        top: 0,
        left: 0,
        width: win.width,
        height: win.height,
        transform: `translate3d(${win.x}px, ${win.y}px, 0)`,
        zIndex: z,
        willChange: "transform",
      };

  return (
    <div
      ref={containerRef}
      data-testid={`window-${win.appId}`}
      className={`absolute flex flex-col overflow-hidden rounded-xl border bg-[#15171e]/95 shadow-2xl backdrop-blur-md transition-shadow ${
        isFocused ? "border-white/20 ring-1 ring-white/10" : "border-white/10"
      }`}
      style={style}
      onPointerDown={() => focus(win.id)}
      role="dialog"
      aria-label={win.title}
    >
      <div
        className="flex h-9 shrink-0 cursor-grab items-center gap-2 border-b border-white/10 bg-white/5 px-3 active:cursor-grabbing select-none"
        onPointerDown={startDrag}
        onDoubleClick={() => toggleMaximize(win.id)}
      >
        <div className="flex items-center gap-2">
          <button
            aria-label="Close"
            onClick={(e) => { e.stopPropagation(); close(win.id); }}
            onPointerDown={(e) => e.stopPropagation()}
            className="h-3 w-3 rounded-full bg-[#ff5f57] transition-opacity hover:opacity-80"
          />
          <button
            aria-label="Minimize"
            onClick={(e) => { e.stopPropagation(); minimize(win.id); }}
            onPointerDown={(e) => e.stopPropagation()}
            className="h-3 w-3 rounded-full bg-[#febc2e] transition-opacity hover:opacity-80"
          />
          <button
            aria-label="Maximize"
            onClick={(e) => { e.stopPropagation(); toggleMaximize(win.id); }}
            onPointerDown={(e) => e.stopPropagation()}
            className="h-3 w-3 rounded-full bg-[#28c840] transition-opacity hover:opacity-80"
          />
        </div>
        <span className="pointer-events-none flex-1 truncate text-center text-xs font-medium text-white/70">
          {win.title}
        </span>
        {/* Occupies the spacer that balances the centred title. An icon, not a
            fourth traffic light — this is a mode that stays on, not an action. */}
        <div className="flex w-12 justify-end">
          <button
            aria-label={win.alwaysOnTop ? "Unpin window" : "Pin window on top"}
            aria-pressed={!!win.alwaysOnTop}
            title={win.alwaysOnTop ? "Always on top — click to unpin" : "Keep this window on top"}
            onClick={(e) => { e.stopPropagation(); togglePin(win.id); }}
            onPointerDown={(e) => e.stopPropagation()}
            className={`rounded p-1 transition-colors ${
              win.alwaysOnTop ? "text-[#5b8cff] hover:bg-white/10" : "text-white/25 hover:bg-white/10 hover:text-white/60"
            }`}
          >
            {win.alwaysOnTop ? <Pin size={12} /> : <PinOff size={12} />}
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 bg-[#0f1117] text-white/90">
        {manifest?.kind === "iframe" ? (
          <IframeApp windowId={win.id} appId={win.appId} params={{ ...win.params, url: manifest.url, capabilities: manifest.capabilities, origin: manifest.origin }} />
        ) : AppComponent ? (
          createElement(AppComponent, { windowId: win.id, appId: win.appId, params: win.params })
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-white/40">
            Unknown app: {win.appId}
          </div>
        )}
      </div>

      {!win.maximized && (
        <>
          {/* Edges — inset past the corner handles so corners take priority
              in the small region where an edge and a corner would overlap. */}
          <div onPointerDown={(e) => startResize(e, "n")} className="absolute inset-x-3 top-0 h-1.5 cursor-ns-resize" />
          <div onPointerDown={(e) => startResize(e, "s")} className="absolute inset-x-3 bottom-0 h-1.5 cursor-ns-resize" />
          <div onPointerDown={(e) => startResize(e, "w")} className="absolute inset-y-3 left-0 w-1.5 cursor-ew-resize" />
          <div onPointerDown={(e) => startResize(e, "e")} className="absolute inset-y-3 right-0 w-1.5 cursor-ew-resize" />
          {/* Corners */}
          <div onPointerDown={(e) => startResize(e, "nw")} className="absolute left-0 top-0 h-3 w-3 cursor-nwse-resize" />
          <div onPointerDown={(e) => startResize(e, "ne")} className="absolute right-0 top-0 h-3 w-3 cursor-nesw-resize" />
          <div onPointerDown={(e) => startResize(e, "sw")} className="absolute bottom-0 left-0 h-3 w-3 cursor-nesw-resize" />
          <div
            onPointerDown={(e) => startResize(e, "se")}
            className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
            style={{ background: "linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.25) 50%)" }}
          />
        </>
      )}
    </div>
  );
}
