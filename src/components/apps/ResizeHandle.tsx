"use client";

import { useCallback, useRef } from "react";

// A thin draggable divider for resizing a sibling panel's width. The consumer
// owns the width (getWidth/setWidth); the handle clamps to [min, max]. Set
// `invert` for a handle on the LEFT edge of the panel it sizes (e.g. a right-hand
// panel), where dragging left should grow the panel. Listeners live on `window`
// so the drag keeps tracking even when the pointer crosses other elements.
export function ResizeHandle({
  getWidth,
  setWidth,
  min = 120,
  max = 800,
  invert = false,
}: {
  getWidth: () => number;
  setWidth: (width: number) => void;
  min?: number;
  max?: number;
  invert?: boolean;
}) {
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  const onMove = useRef<(e: PointerEvent) => void>(() => {});
  const onUp = useRef<() => void>(() => {});

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      drag.current = { startX: e.clientX, startW: getWidth() };
      document.body.style.userSelect = "none";
      onMove.current = (ev: PointerEvent) => {
        const d = drag.current;
        if (!d) return;
        const delta = (ev.clientX - d.startX) * (invert ? -1 : 1);
        setWidth(Math.max(min, Math.min(max, d.startW + delta)));
      };
      onUp.current = () => {
        drag.current = null;
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", onMove.current);
        window.removeEventListener("pointerup", onUp.current);
      };
      window.addEventListener("pointermove", onMove.current);
      window.addEventListener("pointerup", onUp.current);
    },
    [getWidth, setWidth, min, max, invert],
  );

  return (
    <div
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
      className="w-1 shrink-0 cursor-col-resize bg-white/5 transition-colors hover:bg-sky-400/40"
    />
  );
}
