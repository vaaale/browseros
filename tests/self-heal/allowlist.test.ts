import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { isBosOwnedLogComponent, isEnvironmentalError, BOS_OWNED_LOG_COMPONENTS } from "../../src/lib/self-heal/allowlist";

// 031-self-healing FR-002 (+ clarification C2) and FR-005 (+ design R8).
//
// This filter decides whether a failure gets an LLM investigation at all, so
// both directions of getting it wrong are expensive: too loose burns the daily
// token cap on network blips (SC-003 says zero cases, zero tokens), too tight
// silently swallows real bugs.

test.describe("isEnvironmentalError — what is suppressed", () => {
  test("network and socket failures", () => {
    for (const errorCode of ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"]) {
      expect(isEnvironmentalError({ errorCode })).toBe(true);
    }
    expect(isEnvironmentalError({ errorMessage: "socket hang up" })).toBe(true);
    expect(isEnvironmentalError({ errorMessage: "certificate has expired" })).toBe(true);
  });

  test("DNS resolution failures", () => {
    expect(isEnvironmentalError({ errorCode: "ENOTFOUND" })).toBe(true);
    expect(isEnvironmentalError({ errorCode: "EAI_AGAIN" })).toBe(true);
    expect(isEnvironmentalError({ errorMessage: "getaddrinfo failed for api.example.com" })).toBe(true);
  });

  test("401 auth and 429 rate limits from an external service", () => {
    expect(isEnvironmentalError({ httpStatus: 401 })).toBe(true);
    expect(isEnvironmentalError({ httpStatus: 429 })).toBe(true);
    expect(isEnvironmentalError({ errorMessage: "HTTP 401 Unauthorized" })).toBe(true);
    expect(isEnvironmentalError({ errorMessage: "rate limit exceeded, retry later" })).toBe(true);
    expect(isEnvironmentalError({ errorMessage: "invalid api key" })).toBe(true);
  });

  test("OOM and SIGKILL", () => {
    expect(isEnvironmentalError({ errorCode: "ENOMEM" })).toBe(true);
    expect(isEnvironmentalError({ errorMessage: "JavaScript heap out of memory" })).toBe(true);
    expect(isEnvironmentalError({ errorMessage: "process killed: 9" })).toBe(true);
  });

  test("external service / gateway timeouts", () => {
    expect(isEnvironmentalError({ httpStatus: 504 })).toBe(true);
    expect(isEnvironmentalError({ errorMessage: "504 Gateway Timeout" })).toBe(true);
    expect(isEnvironmentalError({ errorMessage: "upstream request timed out" })).toBe(true);
  });
});

test.describe("isEnvironmentalError — what is NOT suppressed", () => {
  test("permission_denied ALWAYS triggers (clarification C2)", () => {
    // The whole point: only investigation distinguishes "your disk said no"
    // (class a) from "BOS dropped the permission" (class e), so this one has to
    // reach the Diagnostician.
    expect(isEnvironmentalError({ errorMessage: "permission denied" })).toBe(false);
    expect(isEnvironmentalError({ errorCode: "EACCES" })).toBe(false);
    expect(isEnvironmentalError({ errorCode: "EPERM" })).toBe(false);
  });

  test("403 is NOT in the allowlist — only 401 is", () => {
    expect(isEnvironmentalError({ httpStatus: 403 })).toBe(false);
  });

  test("ordinary BOS-side failures reach the mechanism", () => {
    expect(isEnvironmentalError({ errorCode: "ENOENT" })).toBe(false);
    expect(isEnvironmentalError({ errorMessage: "params is not a function" })).toBe(false);
    expect(isEnvironmentalError({ errorMessage: "unknown tool bos_app_launch" })).toBe(false);
    expect(isEnvironmentalError({ httpStatus: 404 })).toBe(false);
    expect(isEnvironmentalError({ httpStatus: 500 })).toBe(false);
  });

  test("an explicit report is never suppressed, even if it mentions a timeout", () => {
    expect(
      isEnvironmentalError({ trigger: "explicit", errorMessage: "the request timed out and I think that's a BOS bug" }),
    ).toBe(false);
  });

  test("an empty error is not treated as environmental", () => {
    expect(isEnvironmentalError({})).toBe(false);
    expect(isEnvironmentalError({ errorMessage: "" })).toBe(false);
  });
});

test.describe("isBosOwnedLogComponent (FR-005 / R8)", () => {
  test("owned namespaces and their sub-namespaces are included", () => {
    for (const owned of BOS_OWNED_LOG_COMPONENTS) {
      expect(isBosOwnedLogComponent(owned)).toBe(true);
      expect(isBosOwnedLogComponent(`${owned}.something`)).toBe(true);
    }
    expect(isBosOwnedLogComponent("assistant.run-manager")).toBe(true);
    expect(isBosOwnedLogComponent("SCHEDULER.executor")).toBe(true);
  });

  test("it is an ALLOWLIST — an unknown component is excluded by default", () => {
    expect(isBosOwnedLogComponent("some-marketplace-service")).toBe(false);
    expect(isBosOwnedLogComponent("okf-knowledge-base")).toBe(false);
    expect(isBosOwnedLogComponent("")).toBe(false);
    expect(isBosOwnedLogComponent(undefined)).toBe(false);
  });

  test("third-party surfaces living under an owned root are explicitly excluded", () => {
    // A noisy MCP server or integration must not be able to conscript the
    // self-healer into "fixing" BOS.
    expect(isBosOwnedLogComponent("assistant.mcp")).toBe(false);
    expect(isBosOwnedLogComponent("assistant.mcp.client")).toBe(false);
    expect(isBosOwnedLogComponent("agent.mcp.transport")).toBe(false);
    expect(isBosOwnedLogComponent("integrations")).toBe(false);
    expect(isBosOwnedLogComponent("integrations.gsuite")).toBe(false);
    expect(isBosOwnedLogComponent("gsuite.gmail")).toBe(false);
    expect(isBosOwnedLogComponent("telegram.bot")).toBe(false);
    expect(isBosOwnedLogComponent("service.workflows")).toBe(false);
  });

  test("a near-miss prefix is not a match (owned matching is on dot boundaries)", () => {
    expect(isBosOwnedLogComponent("assistantx")).toBe(false);
    expect(isBosOwnedLogComponent("schedulerish.thing")).toBe(false);
  });
});
