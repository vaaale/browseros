// Unit tests for ResizeHandle's pure drag-session state machine
// (033-fix-pane-resize, FR-001…005, FR-015). No DOM: pointer capture, window
// listeners, and rAF coalescing live in ResizeHandle.tsx itself and are
// exercised by e2e/033-fix-pane-resize.spec.ts instead — this file covers
// only the pointer-id scoping, width clamping, and end-exactly-once rules.
//   npm run test:unit -- tests/apps/resize-handle-session.test.ts
import { test, expect } from "@playwright/test";
import { DragSession } from "../../src/components/apps/resize-handle-session";

test("tracks the initiating pointer's movement, clamped to [min, max]", () => {
  const s = new DragSession(1, 100, 200);
  expect(s.widthFor(1, 130, 120, 800)).toBe(230);
  expect(s.widthFor(1, 100, 120, 800)).toBe(200);
  expect(s.widthFor(1, -1000, 120, 800)).toBe(120); // clamped to min
  expect(s.widthFor(1, 1000, 120, 800)).toBe(800); // clamped to max
});

test("invert flips the sign of the delta (right-edge handle growing a left-hand panel)", () => {
  const s = new DragSession(1, 100, 200);
  expect(s.widthFor(1, 130, 120, 800, true)).toBe(170);
  expect(s.widthFor(1, 70, 120, 800, true)).toBe(230);
});

test("ignores pointermove from any pointer other than the one that started the session (FR-003)", () => {
  const s = new DragSession(1, 100, 200);
  expect(s.widthFor(2, 500, 120, 800)).toBeNull();
  // The real initiating pointer is unaffected by the foreign one having been seen.
  expect(s.widthFor(1, 150, 120, 800)).toBe(250);
});

test("end() is idempotent — true only the first call (FR-002: pointerup and pointercancel both end it, exactly once)", () => {
  const s = new DragSession(1, 100, 200);
  expect(s.isEnded).toBe(false);
  expect(s.end()).toBe(true);
  expect(s.isEnded).toBe(true);
  expect(s.end()).toBe(false);
  expect(s.end()).toBe(false);
});

test("no pointermove resumes resizing once the session has ended (FR-004)", () => {
  const s = new DragSession(1, 100, 200);
  s.end();
  expect(s.widthFor(1, 500, 120, 800)).toBeNull();
});
