import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import {
  computeFailureSignature,
  dedupeWindowSecFor,
  errorCategoryOf,
  normalizeErrorMessage,
  sha256Hex,
} from "../../src/lib/self-heal/signature";
import type { TriggerContext } from "../../src/lib/self-heal/types";

// 031-self-healing FR-019 / design ADR-7. The dedupe key is the ONE thing that
// stops a repeating failure from spending Diagnostician tokens on every
// occurrence, and it is computed with no LLM involved — so it is exactly the
// kind of logic that has to be pinned by tests rather than eyeballed.

test.describe("errorCategoryOf", () => {
  test("HTTP status wins over everything else", () => {
    // The message says "not found" but the status says 401 — status is the more
    // reliable signal and FR-019 puts it first.
    expect(errorCategoryOf({ httpStatus: 401, errorMessage: "resource not found" })).toBe("auth");
    expect(errorCategoryOf({ httpStatus: 403 })).toBe("auth");
    expect(errorCategoryOf({ httpStatus: 404 })).toBe("not_found");
    expect(errorCategoryOf({ httpStatus: 408 })).toBe("timeout");
    expect(errorCategoryOf({ httpStatus: 504 })).toBe("timeout");
    expect(errorCategoryOf({ httpStatus: 429 })).toBe("rate_limit");
    expect(errorCategoryOf({ httpStatus: 422 })).toBe("type_mismatch");
    expect(errorCategoryOf({ httpStatus: 500 })).toBe("unhandled_exception");
  });

  test("exception code/class wins over the message", () => {
    expect(errorCategoryOf({ errorCode: "EACCES", errorMessage: "everything is fine" })).toBe("permission_denied");
    expect(errorCategoryOf({ errorCode: "EPERM" })).toBe("permission_denied");
    expect(errorCategoryOf({ errorCode: "ETIMEDOUT" })).toBe("timeout");
    expect(errorCategoryOf({ errorCode: "TimeoutError" })).toBe("timeout");
    expect(errorCategoryOf({ errorCode: "ENOENT" })).toBe("not_found");
    expect(errorCategoryOf({ errorCode: "TypeError" })).toBe("type_mismatch");
    expect(errorCategoryOf({ errorCode: "ValidationError" })).toBe("type_mismatch");
  });

  test("message patterns cover the codeless case", () => {
    expect(errorCategoryOf({ errorMessage: "Permission denied" })).toBe("permission_denied");
    expect(errorCategoryOf({ errorMessage: "the request timed out after 30s" })).toBe("timeout");
    expect(errorCategoryOf({ errorMessage: "no such file or directory" })).toBe("not_found");
    expect(errorCategoryOf({ errorMessage: "unknown tool foo" })).toBe("not_found");
    expect(errorCategoryOf({ errorMessage: "Too Many Requests" })).toBe("rate_limit");
    expect(errorCategoryOf({ errorMessage: "invalid api key" })).toBe("auth");
    expect(errorCategoryOf({ errorMessage: "params is not a function" })).toBe("type_mismatch");
  });

  test("permission_denied is preferred over a bare timeout mention", () => {
    // Ordering matters: the patterns are most-specific-first, so a message
    // containing both words classifies as the more actionable one.
    expect(errorCategoryOf({ errorMessage: "permission denied; the operation timed out" })).toBe("permission_denied");
  });

  test("an unrecognizable failure is unhandled_exception, not a guess", () => {
    expect(errorCategoryOf({})).toBe("unhandled_exception");
    expect(errorCategoryOf({ errorMessage: "boom" })).toBe("unhandled_exception");
    expect(errorCategoryOf({ errorCode: "SomethingNovel", errorMessage: "boom" })).toBe("unhandled_exception");
  });
});

test.describe("normalizeErrorMessage", () => {
  test("strips UUIDs, hex ids, timestamps, quoted strings and numbers", () => {
    const a = normalizeErrorMessage(
      'run 3f4a1c2e-9b7d-4a1f-8e2c-1a2b3c4d5e6f failed at 2026-09-07T11:22:33Z after 4213 ms: "portfolio.md" missing',
    );
    const b = normalizeErrorMessage(
      'run 00000000-0000-0000-0000-000000000000 failed at 2026-01-01T00:00:00Z after 7 ms: "other.md" missing',
    );
    expect(a).toBe(b);
    expect(a).not.toContain("portfolio");
  });

  test("collapses whitespace and lowercases so cosmetic differences don't split a signature", () => {
    expect(normalizeErrorMessage("  Permission   DENIED \n on write ")).toBe("permission denied on write");
  });

  test("path-prefix stripping (default on) merges the same bug at different roots", () => {
    const home = normalizeErrorMessage("cannot open /home/alice/notes.md", { stripPathPrefix: true });
    const app = normalizeErrorMessage("cannot open /app/data/notes.md", { stripPathPrefix: true });
    expect(home).toBe(app);
  });

  test("path-prefix stripping can be turned off to keep distinct roots distinct", () => {
    const home = normalizeErrorMessage("cannot open /home/alice/notes.md", { stripPathPrefix: false });
    const app = normalizeErrorMessage("cannot open /app/data/notes.md", { stripPathPrefix: false });
    expect(home).not.toBe(app);
  });

  test("an empty or missing message normalizes to an empty string rather than throwing", () => {
    expect(normalizeErrorMessage("")).toBe("");
    expect(normalizeErrorMessage(undefined as unknown as string)).toBe("");
  });
});

test.describe("computeFailureSignature", () => {
  const hardError = (over: Partial<TriggerContext> = {}): TriggerContext => ({
    trigger: "hard-error",
    toolName: "file_read",
    errorMessage: "permission denied reading /home/alice/x.md",
    ...over,
  });

  test("is deterministic and SHA-256 based", () => {
    const one = computeFailureSignature(hardError());
    const two = computeFailureSignature(hardError());
    expect(one.dedupeKey).toBe(two.dedupeKey);
    expect(one.normalizedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(one.dedupeKey).toBe(`file_read:permission_denied:${one.normalizedHash}`);
  });

  test("the same logical failure at a different path dedupes to one key", () => {
    const a = computeFailureSignature(hardError({ errorMessage: "permission denied reading /home/alice/x.md" }));
    const b = computeFailureSignature(hardError({ errorMessage: "permission denied reading /app/data/y.md" }));
    expect(a.dedupeKey).toBe(b.dedupeKey);
  });

  test("different tools never share a key", () => {
    const a = computeFailureSignature(hardError({ toolName: "file_read" }));
    const b = computeFailureSignature(hardError({ toolName: "file_write" }));
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });

  test("the category is folded into the hash so two uninformative messages don't collide", () => {
    const timeout = computeFailureSignature({ trigger: "hard-error", toolName: "t", errorMessage: "failed", errorCode: "ETIMEDOUT" });
    const perms = computeFailureSignature({ trigger: "hard-error", toolName: "t", errorMessage: "failed", errorCode: "EACCES" });
    expect(timeout.normalizedHash).not.toBe(perms.normalizedHash);
  });

  test("the explicit trigger gets the RELAXED key over the description", () => {
    const sig = computeFailureSignature({ trigger: "explicit", description: "bos_app_launch drops the file param", toolName: "bos_app_launch" });
    expect(sig.errorCategory).toBe("explicit");
    expect(sig.dedupeKey).toBe(`bos_app_launch:explicit:${sha256Hex(normalizeErrorMessage("bos_app_launch drops the file param"))}`);
    expect(sig.label).toBe("bos_app_launch drops the file param");
  });

  test("a workflow timeout derives its tool name from the workflow id", () => {
    const sig = computeFailureSignature({
      trigger: "workflow-timeout",
      workflow: { id: "daily-review", node: "research", configuredMs: 10_000, actualMs: 30_000 },
      errorCode: "TimeoutError",
      errorMessage: "workflow daily-review exceeded its configured timeout",
    });
    expect(sig.toolName).toBe("workflow:daily-review");
    expect(sig.errorCategory).toBe("timeout");
    expect(sig.label).toContain("daily-review");
    expect(sig.label).toContain("research");
  });

  test("a log-event trigger falls back to the component as the tool name", () => {
    const sig = computeFailureSignature({ trigger: "log-events", component: "assistant.run-manager", errorMessage: "run wedged" });
    expect(sig.toolName).toBe("assistant.run-manager");
  });

  test("with no tool, no workflow and no component it still produces a usable key", () => {
    const sig = computeFailureSignature({ trigger: "explicit", description: "something is off" });
    expect(sig.toolName).toBe("self_heal.request");
    expect(sig.dedupeKey.startsWith("self_heal.request:explicit:")).toBe(true);
  });

  test("labels are truncated so a wall of text can't become a case title", () => {
    const sig = computeFailureSignature({ trigger: "explicit", description: "x".repeat(500) });
    expect(sig.label.length).toBeLessThanOrEqual(120);
    expect(sig.label.endsWith("…")).toBe(true);
  });
});

test.describe("dedupeWindowSecFor", () => {
  test("the explicit trigger uses the SHORTER window (re-reporting is deliberate)", () => {
    const cfg = { dedupeWindowSec: 86_400, explicitDedupeWindowSec: 3_600 };
    expect(dedupeWindowSecFor("explicit", cfg)).toBe(3_600);
    expect(dedupeWindowSecFor("hard-error", cfg)).toBe(86_400);
    expect(dedupeWindowSecFor("repeated-failure", cfg)).toBe(86_400);
    expect(dedupeWindowSecFor("workflow-timeout", cfg)).toBe(86_400);
    expect(dedupeWindowSecFor("log-events", cfg)).toBe(86_400);
  });
});

test.describe("label edge cases", () => {
  test("an explicit report with no description falls back to the error, then to a stock phrase", () => {
    expect(computeFailureSignature({ trigger: "explicit", errorMessage: "it exploded" }).label).toBe("it exploded");
    expect(computeFailureSignature({ trigger: "explicit" }).label).toBe("reported problem");
  });

  test("a workflow timeout with no node omits the node clause", () => {
    const sig = computeFailureSignature({ trigger: "workflow-timeout", workflow: { id: "wf" }, errorCode: "TimeoutError" });
    expect(sig.label).toBe("workflow wf timed out");
  });

  test("a workflow-timeout trigger with NO workflow object still labels from the tool", () => {
    const sig = computeFailureSignature({ trigger: "workflow-timeout", toolName: "workflow_run", errorCode: "TimeoutError" });
    expect(sig.toolName).toBe("workflow_run");
    expect(sig.label).toBe("workflow_run: timeout");
  });

  test("a failure with no tool, component or message labels as 'unknown'", () => {
    expect(computeFailureSignature({ trigger: "hard-error" }).label).toBe("self_heal.request: unhandled_exception");
  });

  test("a hard error with no message hashes consistently", () => {
    const a = computeFailureSignature({ trigger: "hard-error", toolName: "t" });
    const b = computeFailureSignature({ trigger: "hard-error", toolName: "t", errorMessage: "" });
    expect(a.dedupeKey).toBe(b.dedupeKey);
  });

  test("a component-only signature keeps the component as the tool name", () => {
    const sig = computeFailureSignature({ trigger: "log-events", component: "events.kernel" });
    expect(sig.toolName).toBe("events.kernel");
    expect(sig.label).toBe("events.kernel: unhandled_exception");
  });

  test("errorCategoryOf ignores a nonsensical HTTP status and falls through", () => {
    expect(errorCategoryOf({ httpStatus: 0, errorMessage: "permission denied" })).toBe("permission_denied");
    expect(errorCategoryOf({ httpStatus: -1, errorCode: "ETIMEDOUT" })).toBe("timeout");
    // A status BOS has no mapping for falls through to the code/message.
    expect(errorCategoryOf({ httpStatus: 301, errorCode: "ENOENT" })).toBe("not_found");
    expect(errorCategoryOf({ httpStatus: 301 })).toBe("unhandled_exception");
  });

  test("a blank error code is skipped rather than looked up", () => {
    expect(errorCategoryOf({ errorCode: "   ", errorMessage: "permission denied" })).toBe("permission_denied");
  });

  test("normalization handles a message that is only variable tokens", () => {
    expect(normalizeErrorMessage("2026-09-07T10:00:00Z 12345 'x'")).toBe("<x>");
  });
});
