// Unit tests for MessageListV2's stick-to-bottom decision logic
// (033-fix-pane-resize, FR-011/012). The component defers the actual
// scrollTop write behind requestAnimationFrame, using this pure predicate to
// decide whether the deferred write should still happen — see
// e2e/033-fix-pane-resize.spec.ts for the real-browser ResizeObserver path.
//   npm run test:unit -- tests/agent/stick-to-bottom.test.ts
import { test, expect } from "@playwright/test";
import { shouldStickScroll } from "../../src/components/agent/v2/stick-to-bottom";

test("a pinned list whose scroll position lags the content follows it (resize/new content)", () => {
  expect(shouldStickScroll(true, 500, 900)).toBe(true);
});

test("a pinned list already at the bottom is left alone — no no-op scrollTop write", () => {
  expect(shouldStickScroll(true, 900, 900)).toBe(false);
});

test("a list the user has scrolled up on is never forced to the bottom, even mid-resize", () => {
  expect(shouldStickScroll(false, 500, 900)).toBe(false);
  expect(shouldStickScroll(false, 900, 900)).toBe(false);
});
