"use client";

import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { WindowInstance } from "@/os/types";
import { useOSStore } from "@/store/os-provider";
import { getAppComponent } from "@/components/apps/registry";
import { IframeApp } from "@/components/apps/IframeApp";

const TOPBAR_H = 32;

export function Window({ win }: { win: WindowInstance }) {
  const focus = useOSStore((s) => s.focus);
  const close = useOSStore((s) => s.close);
  const minimize = useOSStore((s) => s.minimize);
  const toggleMaximize = useOSStore((s) => s.toggleMaximize);
  const move = useOSStore((s) => s.move);
  const resize = useOSStore((s) => s.resize);
  const focusedId = useOSStore((s) => s.focusedId);
  const manifest = useOSStore((s) => s.apps.find((a) => a.id === win.appId));

  const dragState = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const resizeState = useRef<{ pointerId: number; startX: number; startY: number; startW: number; startH: number } | null>(null);

  const onDragMove = useCallback(
    (e: PointerEvent) => {
      const d = dragState.current;
      if (!d || e.pointerId !== d.pointerId) return;
      move(win.id, e.clientX - d.offsetX, e.clientY - d.offsetY);
    },
    [move, win.id],
  );

  const onDragEnd = useCallback(() => {
    dragState.current = null;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
  }, [onDragMove]);

  const startDrag = useCallback(
    (e: ReactPointerEvent) => {
      if (win.maximized) return;
      focus(win.id);
      dragState.current = { pointerId: e.pointerId, offsetX: e.clientX - win.x, offsetY: e.clientY - win.y };
      window.addEventListener("pointermove", onDragMove);
      window.addEventListener("pointerup", onDragEnd);
    },
    [focus, onDragEnd, onDragMove, win.id, win.maximized, win.x, win.y],
  );

  const onResizeMove = useCallback(
    (e: PointerEvent) => {
      const r = resizeState.current;
      if (!r || e.pointerId !== r.pointerId) return;
      resize(win.id, {
        width: r.startW + (e.clientX - r.startX),
        height: r.startH + (e.clientY - r.startY),
      });
    },
    [resize, win.id],
  );

  const onResizeEnd = useCallback(() => {
    resizeState.current = null;
    window.removeEventListener("pointermove", onResizeMove);
    window.removeEventListener("pointerup", onResizeEnd);
  }, [onResizeMove]);

  const startResize = useCallback(
    (e: ReactPointerEvent) => {
      e.stopPropagation();
      focus(win.id);
      resizeState.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, startW: win.width, startH: win.height };
      window.addEventListener("pointermove", onResizeMove);
      window.addEventListener("pointerup", onResizeEnd);
    },
    [focus, onResizeEnd, onResizeMove, win.height, win.id, win.width],
  );

  if (win.minimized) return null;

  const AppComponent = getAppComponent(win.appId);
  const isFocused = focusedId === win.id;

  const style: React.CSSProperties = win.maximized
    ? { top: TOPBAR_H + 8, left: 8, right: 8, bottom: 84, zIndex: win.zIndex }
    : { top: win.y, left: win.x, width: win.width, height: win.height, zIndex: win.zIndex };

  return (
    <div
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
        <div className="w-12" />
      </div>

      <div className="relative min-h-0 flex-1 bg-[#0f1117] text-white/90">
        {manifest?.kind === "iframe" ? (
          <IframeApp windowId={win.id} appId={win.appId} params={{ ...win.params, url: manifest.url }} />
        ) : AppComponent ? (
          <AppComponent windowId={win.id} appId={win.appId} params={win.params} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-white/40">
            Unknown app: {win.appId}
          </div>
        )}
      </div>

      {!win.maximized && (
        <div
          onPointerDown={startResize}
          className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
          style={{ background: "linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.25) 50%)" }}
        />
      )}
    </div>
  );
}
