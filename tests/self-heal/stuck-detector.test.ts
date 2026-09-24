import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { StuckDetector, normalizeToolInput } from "../../src/lib/self-heal/stuck-detector";

// 031-self-healing scope-add, FR-033 (design ADR-13). The detector is the
// deterministic half of the motivating incident: a self-heal run that called
// `file_search` with the same arguments over and over, made no progress, and
// burned its whole step budget with nobody watching.
//
// Deliberately pure code, no LLM: "the same call again with nothing new in
// between" is a fact, not a judgment. These tests pin both conditions FR-033
// names (repeat-calls and max-steps) and — just as important — the cases that
// must NOT fire, because a false "stuck" on a legitimately repetitive run would
// train the user to ignore the indicator.

test.describe("stuck detection (FR-033, ADR-13)", () => {
  test("the same (tool, normalized input) repeated `repeatCalls` times is stuck", () => {
    const det = new StuckDetector({ repeatCalls: 5 });
    for (let i = 0; i < 4; i++) {
      det.onToolCall("file_search", { dir: "src/components", query: "file_read" });
      expect(det.isStuck().stuck).toBe(false);
    }
    det.onToolCall("file_search", { dir: "src/components", query: "file_read" });

    const verdict = det.isStuck();
    expect(verdict.stuck).toBe(true);
    expect(verdict.reason).toBe("repeat-calls");
    expect(verdict.tool).toBe("file_search");
    expect(verdict.count).toBe(5);
    expect(verdict.repeatedCall).toContain("file_search");
    expect(verdict.normalizedInput).toBeTruthy();
  });

  test("a distinct intervening call resets the streak — a working run is never stuck", () => {
    const det = new StuckDetector({ repeatCalls: 3 });
    det.onToolCall("file_search", { query: "a" });
    det.onToolCall("file_search", { query: "a" });
    det.onToolCall("bos_source_read", { path: "src/lib/x.ts" });
    det.onToolCall("file_search", { query: "a" });
    det.onToolCall("file_search", { query: "a" });
    expect(det.isStuck().stuck).toBe(false);

    // Only a genuinely uninterrupted streak fires.
    det.onToolCall("file_search", { query: "a" });
    expect(det.isStuck()).toMatchObject({ stuck: true, count: 3 });
  });

  test("distinct arguments to the same tool are distinct calls", () => {
    const det = new StuckDetector({ repeatCalls: 3 });
    det.onToolCall("bos_source_read", { path: "src/a.ts" });
    det.onToolCall("bos_source_read", { path: "src/b.ts" });
    det.onToolCall("bos_source_read", { path: "src/c.ts" });
    det.onToolCall("bos_source_read", { path: "src/d.ts" });
    // Reading four different files in a row is exactly what a working agent
    // does; only the SAME read again and again is a loop.
    expect(det.isStuck().stuck).toBe(false);
  });

  test("progress (a final text) resets the streak", () => {
    const det = new StuckDetector({ repeatCalls: 3 });
    det.onToolCall("file_search", { query: "a" });
    det.onToolCall("file_search", { query: "a" });
    det.onProgress();
    det.onToolCall("file_search", { query: "a" });
    expect(det.isStuck().stuck).toBe(false);
  });

  test("input normalization strips ids, timestamps and numerics but keeps the shape", () => {
    // The FR-019 normalization, applied to tool input: two calls that differ
    // only in a generated id / a timestamp / a counter are the SAME call.
    const a = normalizeToolInput({ caseId: "0141", at: "2026-09-08T19:02:02.000Z", query: "file_read" });
    const b = normalizeToolInput({ caseId: "0142", at: "2026-09-08T21:44:10.000Z", query: "file_read" });
    expect(a).toBe(b);

    // …but a different query is a different call.
    expect(normalizeToolInput({ query: "file_read" })).not.toBe(normalizeToolInput({ query: "file_write" }));
    // Key order must not matter.
    expect(normalizeToolInput({ a: "1", b: "two" })).toBe(normalizeToolInput({ b: "two", a: "1" }));
    // A user-specific absolute path prefix is collapsed, as in FR-019.
    expect(normalizeToolInput({ path: "/home/ada/repo/src/x.ts" })).toBe(
      normalizeToolInput({ path: "/home/lin/other/src/x.ts" }),
    );
    // Degenerate inputs are stable, not throws.
    expect(normalizeToolInput(undefined)).toBe(normalizeToolInput(null));
    expect(normalizeToolInput("a string")).toBe(normalizeToolInput("a string"));
    expect(typeof normalizeToolInput([1, 2, 3])).toBe("string");
  });

  test("normalization survives every awkward argument shape", () => {
    // A null/undefined value contributes nothing rather than the string
    // "null" — two calls that differ only by an omitted optional argument are
    // the same call.
    expect(normalizeToolInput({ a: null, b: "x" })).toBe(normalizeToolInput({ a: undefined, b: "x" }));
    // A nested object is serialized, so a nested difference is still a
    // difference.
    expect(normalizeToolInput({ where: { dir: "src" } })).not.toBe(normalizeToolInput({ where: { dir: "docs" } }));
    // A boolean/number value is stringified, not dropped.
    expect(normalizeToolInput({ recursive: true })).not.toBe(normalizeToolInput({ recursive: false }));

    // An input that cannot be serialized (a cycle, which a tool's arguments
    // can hold once they have been through a proxy) degrades to its string
    // form instead of throwing inside the detector.
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    expect(() => normalizeToolInput(circular)).not.toThrow();
    expect(normalizeToolInput(circular)).toContain("name=loop");

    const det = new StuckDetector({ repeatCalls: 2 });
    det.onToolCall("weird", circular);
    det.onToolCall("weird", circular);
    expect(det.isStuck().stuck).toBe(true);
  });

  test("a NaN threshold falls back to the documented default", () => {
    const det = new StuckDetector({ repeatCalls: Number.NaN });
    for (let i = 0; i < 4; i++) det.onToolCall("file_search", { q: "a" });
    expect(det.isStuck().stuck).toBe(false);
    det.onToolCall("file_search", { q: "a" });
    expect(det.isStuck()).toMatchObject({ stuck: true, count: 5 });
  });

  test("a run that ends on max_steps is stuck; one that completes is not (FR-033(b))", () => {
    const exhausted = new StuckDetector();
    expect(exhausted.onRunEnd("max_steps")).toMatchObject({ stuck: true, reason: "max-steps" });
    expect(exhausted.isStuck()).toMatchObject({ stuck: true, reason: "max-steps" });

    for (const reason of ["completed", "cancelled", "error", undefined] as const) {
      expect(new StuckDetector().onRunEnd(reason).stuck).toBe(false);
    }
  });

  test("a repeat-call streak survives the run end and still reports repeat-calls", () => {
    const det = new StuckDetector({ repeatCalls: 2 });
    det.onToolCall("file_search", { query: "a" });
    det.onToolCall("file_search", { query: "a" });
    // The stronger, more specific signal wins: the user wants to know WHAT it
    // was looping on, not just that the budget ran out.
    expect(det.onRunEnd("max_steps")).toMatchObject({ stuck: true, reason: "repeat-calls" });
  });

  test("firing is idempotent per run", () => {
    const det = new StuckDetector({ repeatCalls: 2 });
    det.onToolCall("file_search", { query: "a" });
    det.onToolCall("file_search", { query: "a" });
    expect(det.fired).toBe(false);
    expect(det.isStuck().stuck).toBe(true);
    det.markFired();
    expect(det.fired).toBe(true);
    // Still stuck (the fact does not go away), but the consumer knows it has
    // already recorded and announced it.
    det.onToolCall("file_search", { query: "a" });
    expect(det.isStuck().stuck).toBe(true);
    expect(det.fired).toBe(true);
  });

  test("the threshold is clamped so a nonsense config cannot fire on the first call", () => {
    const det = new StuckDetector({ repeatCalls: 0 });
    det.onToolCall("file_search", { query: "a" });
    expect(det.isStuck().stuck).toBe(false);
    det.onToolCall("file_search", { query: "a" });
    expect(det.isStuck().stuck).toBe(true);
  });
});
