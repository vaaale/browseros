"use client";

import { useCallback, useEffect, useRef } from "react";
import { DragSession } from "./resize-handle-session";

// A thin draggable divider for resizing a sibling panel's width. The consumer
// owns the width (getWidth/setWidth); the handle clamps to [min, max]. Set
// `invert` for a handle on the LEFT edge of the panel it sizes (e.g. a right-hand
// panel), where dragging left should grow the panel. Listeners live on `window`
// so the drag keeps tracking even when the pointer crosses other elements.
//
// Drag-session contract (mirrors the desktop window's own drag/resize in
// Window.tsx — see its startDrag/startResize for the reference pattern; the
// pointer-id-scoped, end-exactly-once state machine itself lives in the pure,
// unit-tested resize-handle-session.ts): the initiating pointer is captured
// on pointerdown, so pointermove/pointerup keep being delivered here even
// while the pointer is over an embedded iframe elsewhere in the window; the
// session ends on EITHER pointerup or pointercancel, exactly once, with
// identical cleanup (drag state cleared, window listeners removed, body
// userSelect restored); pointer events from any pointerId other than the one
// that started the session are ignored; and the width is applied at most
// once per animation frame. Once a session has ended, no residual state can
// let a later pointermove — including one that hovers back over the handle —
// resume resizing.
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
  const drag = useRef<{ session: DragSession; nextWidth: number; rafId: number | null } | null>(null);
  // Holds the exact end-handler reference passed to addEventListener, so the
  // handler can remove its own sibling listener (pointerup vs. pointercancel,
  // whichever didn't fire) via a ref read instead of referencing its own
  // `const` name — self-reference from within a useCallback body is flagged
  // by the React Compiler lint rule as an unsafe stale-closure pattern.
  const endRef = useRef<() => void>(() => {});

  const applyFrame = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    d.rafId = null;
    setWidth(d.nextWidth);
  }, [setWidth]);

  const onMove = useCallback(
    (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const w = d.session.widthFor(e.pointerId, e.clientX, min, max, invert);
      if (w === null) return;
      d.nextWidth = w;
      if (d.rafId === null) d.rafId = requestAnimationFrame(applyFrame);
    },
    [applyFrame, invert, min, max],
  );

  const onEnd = useCallback(() => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", endRef.current);
    window.removeEventListener("pointercancel", endRef.current);
    const d = drag.current;
    if (!d || !d.session.end()) return; // already ended — cleanup already ran
    if (d.rafId !== null) cancelAnimationFrame(d.rafId);
    drag.current = null;
    document.body.style.userSelect = "";
  }, [onMove]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startWidth = getWidth();
      drag.current = { session: new DragSession(e.pointerId, e.clientX, startWidth), nextWidth: startWidth, rafId: null };
      endRef.current = onEnd;
      document.body.style.userSelect = "none";
      // See Window.tsx's startDrag/startResize for the same pattern and
      // rationale: without capture, fast pointer movement over an embedded
      // iframe silently drops move/up events, leaving drag state stuck and
      // the drag "resuming" on the next stray pointermove that reaches window.
      e.currentTarget.setPointerCapture(e.pointerId);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onEnd, { once: true });
      window.addEventListener("pointercancel", onEnd, { once: true });
    },
    [getWidth, onEnd, onMove],
  );

  useEffect(() => {
    return () => {
      const d = drag.current;
      if (d?.rafId != null) cancelAnimationFrame(d.rafId);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
  }, [onEnd, onMove]);

  return (
    <div
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
      className="w-1 shrink-0 cursor-col-resize bg-white/5 transition-colors hover:bg-sky-400/40"
    />
  );
}
