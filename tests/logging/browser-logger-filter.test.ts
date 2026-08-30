// Unit tests for the central browser logger's benign-ResizeObserver filter
// (033-fix-pane-resize, FR-009/010, NFR-003). startBrowserLogging() itself
// requires a real `window` (it's a no-op without one — see its own guard),
// so this exercises the exported predicate it gates on directly rather than
// standing up a DOM. The e2e test (e2e/033-fix-pane-resize.spec.ts) covers
// the full window.onerror -> log-record path in a real browser.
//   npm run test:unit -- tests/logging/browser-logger-filter.test.ts
import { test, expect } from "@playwright/test";
import { isBenignResizeObserverMessage } from "../../src/lib/logging/client/browser-logger";

test("drops both known-benign ResizeObserver notifications", () => {
  expect(isBenignResizeObserverMessage("ResizeObserver loop completed with undelivered notifications")).toBe(true);
  expect(isBenignResizeObserverMessage("ResizeObserver loop limit exceeded")).toBe(true);
});

test("drops the trailing-period variant Chromium actually emits for the 'completed' notification", () => {
  // Confirmed via a real window.onerror capture in Chrome — the "completed"
  // message carries a trailing period the spec's literal wording omits.
  expect(isBenignResizeObserverMessage("ResizeObserver loop completed with undelivered notifications.")).toBe(true);
  expect(isBenignResizeObserverMessage("ResizeObserver loop limit exceeded.")).toBe(true);
});

test("still logs any other error, including ones that merely mention ResizeObserver (NFR-003: no substring match)", () => {
  expect(isBenignResizeObserverMessage("TypeError: cannot read properties of undefined")).toBe(false);
  expect(isBenignResizeObserverMessage("ResizeObserver loop completed with undelivered notifications and then something else")).toBe(false);
  expect(isBenignResizeObserverMessage("my app's own ResizeObserver loop detector tripped")).toBe(false);
  expect(isBenignResizeObserverMessage("")).toBe(false);
});
