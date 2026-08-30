// Pure, DOM-free drag-session state machine backing ResizeHandle's pointer
// handling (FR-001…005). Kept separate from the component so the lifecycle
// rules — pointer-id scoping, clamped width, end-exactly-once — are unit
// testable without a browser (see tests/apps/resize-handle-session.test.ts).
// All DOM concerns (pointer capture, window listeners, rAF coalescing, body
// text-selection suppression) stay in ResizeHandle.tsx.
export class DragSession {
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
  private ended = false;

  constructor(pointerId: number, startX: number, startWidth: number) {
    this.pointerId = pointerId;
    this.startX = startX;
    this.startWidth = startWidth;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** The clamped width for a pointermove, or null if the event should be
   *  ignored — a foreign pointerId (FR-003) or a session that already ended
   *  (FR-004: no residual state may resume resizing after the fact). */
  widthFor(pointerId: number, clientX: number, min: number, max: number, invert = false): number | null {
    if (this.ended || pointerId !== this.pointerId) return null;
    const delta = (clientX - this.startX) * (invert ? -1 : 1);
    return Math.max(min, Math.min(max, this.startWidth + delta));
  }

  /** Ends the session. Idempotent (FR-002): returns true only the first
   *  time, so a caller driven by both a pointerup and a pointercancel (or
   *  any other double-fire) runs its cleanup exactly once. */
  end(): boolean {
    if (this.ended) return false;
    this.ended = true;
    return true;
  }
}
