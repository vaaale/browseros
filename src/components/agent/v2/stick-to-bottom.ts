// Pure decision logic behind MessageListV2's stick-to-bottom ResizeObserver
// handling (033-fix-pane-resize, FR-011/012). Kept separate from the
// component so it's unit testable without a DOM (see
// tests/agent/stick-to-bottom.test.ts); the component itself still performs
// the actual scrollTop write, deferred to the next animation frame.
/** Whether a deferred stick-to-bottom adjustment should actually write
 *  scrollTop: only while still pinned (the user may have scrolled up during
 *  the deferred frame) and only if it would change anything — skips a
 *  no-op write when the list is already at the bottom. */
export function shouldStickScroll(stickToBottom: boolean, scrollTop: number, scrollHeight: number): boolean {
  return stickToBottom && scrollTop !== scrollHeight;
}
