// workerIpc: postMessage / waitForMessage — real worker_threads (eval:true
// inline scripts, no fixture files needed since these don't go through
// ServiceManager's file-path-based Worker construction).
//   npx playwright test -c playwright.unit.config.ts tests/services/workerIpc.test.ts
import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import { Worker } from "node:worker_threads";
import { postMessage, waitForMessage, sendToolCall, waitForToolResult } from "../../src/core/service/workerIpc";

function echoWorker(): Worker {
  return new Worker(
    `
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", (msg) => {
      if (msg && msg.type === "initialize") parentPort.postMessage({ type: "initialized" });
    });
    `,
    { eval: true },
  );
}

test.describe("postMessage", () => {
  test("sends a message to the worker thread", async () => {
    const worker = echoWorker();
    try {
      const received = waitForMessage(worker, "initialized", 5_000);
      postMessage(worker, { type: "initialize", configDirPath: "/c", logsPath: "/l", serviceId: "s" });
      await expect(received).resolves.toEqual({ type: "initialized" });
    } finally {
      await worker.terminate();
    }
  });
});

test.describe("waitForMessage", () => {
  test("resolves with the message once the matching type arrives", async () => {
    const worker = echoWorker();
    try {
      const promise = waitForMessage(worker, "initialized", 5_000);
      worker.postMessage({ type: "initialize" });
      const msg = await promise;
      expect(msg.type).toBe("initialized");
    } finally {
      await worker.terminate();
    }
  });

  test("ignores non-matching message types before resolving on the right one", async () => {
    const worker = new Worker(
      `
      const { parentPort } = require("node:worker_threads");
      parentPort.on("message", (msg) => {
        if (msg && msg.type === "initialize") {
          parentPort.postMessage({ type: "log", level: "info", message: "starting" });
          parentPort.postMessage({ type: "initialized" });
        }
      });
      `,
      { eval: true },
    );
    try {
      const promise = waitForMessage(worker, "initialized", 5_000);
      worker.postMessage({ type: "initialize" });
      const msg = await promise;
      expect(msg).toEqual({ type: "initialized" });
    } finally {
      await worker.terminate();
    }
  });

  test("rejects on timeout when the worker never sends the expected message", async () => {
    const worker = new Worker(`const { parentPort } = require("node:worker_threads"); parentPort.on("message", () => {});`, {
      eval: true,
    });
    try {
      await expect(waitForMessage(worker, "initialized", 100)).rejects.toThrow(/timed out waiting for "initialized"/);
    } finally {
      await worker.terminate();
    }
  });

  test("rejects if the worker exits before sending the expected message", async () => {
    const worker = new Worker(`process.exit(0);`, { eval: true });
    await expect(waitForMessage(worker, "initialized", 5_000)).rejects.toThrow(/worker exited before sending "initialized"/);
  });
});

// 039-service-tool-exposure Phase 4 (US3 — isolated + crash-safe invocation).
// A worker that answers `tool_call` with `tool_result`, keyed by callId, so
// concurrent calls can be told apart. `args.delayMs` lets a test make a later
// call reply before an earlier one, to prove callId-keying (not arrival
// order) determines which waiter resolves.
function toolEchoWorker(): Worker {
  return new Worker(
    `
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", (msg) => {
      if (!msg || msg.type !== "tool_call") return;
      const { callId, args } = msg.payload;
      const delayMs = (args && args.delayMs) || 0;
      setTimeout(() => {
        parentPort.postMessage({ type: "tool_result", payload: { callId, result: (args && args.text) || callId } });
      }, delayMs);
    });
    `,
    { eval: true },
  );
}

test.describe("sendToolCall / waitForToolResult", () => {
  test("resolves with the tool_result matching the callId", async () => {
    const worker = toolEchoWorker();
    try {
      const promise = waitForToolResult(worker, "call-1", 5_000);
      sendToolCall(worker, { callId: "call-1", name: "echo_tool", args: { text: "hi" } });
      await expect(promise).resolves.toEqual({ callId: "call-1", result: "hi" });
    } finally {
      await worker.terminate();
    }
  });

  test("rejects on timeout when the worker never replies", async () => {
    const worker = new Worker(`const { parentPort } = require("node:worker_threads"); parentPort.on("message", () => {});`, {
      eval: true,
    });
    try {
      await expect(waitForToolResult(worker, "call-1", 100)).rejects.toThrow(/timed out waiting for tool call "call-1"/);
    } finally {
      await worker.terminate();
    }
  });

  test("cleans up its message/exit listeners once settled — no waiter leak", async () => {
    const worker = toolEchoWorker();
    try {
      const promise = waitForToolResult(worker, "call-1", 5_000);
      expect(worker.listenerCount("message")).toBe(1);
      expect(worker.listenerCount("exit")).toBe(1);
      sendToolCall(worker, { callId: "call-1", name: "echo_tool", args: { text: "hi" } });
      await promise;
      expect(worker.listenerCount("message")).toBe(0);
      expect(worker.listenerCount("exit")).toBe(0);
    } finally {
      await worker.terminate();
    }
  });

  // T030 — worker crash mid-tool_call: the pending waiter rejects cleanly
  // ("worker exited before...") instead of hanging or throwing an unhandled
  // rejection; BOS (the main thread running this test) stays healthy.
  test("rejects with 'worker exited before...' when the worker exits mid tool_call", async () => {
    const worker = new Worker(
      `
      const { parentPort } = require("node:worker_threads");
      parentPort.on("message", (msg) => {
        if (msg && msg.type === "tool_call") process.exit(1);
      });
      `,
      { eval: true },
    );
    const promise = waitForToolResult(worker, "call-1", 5_000);
    sendToolCall(worker, { callId: "call-1", name: "echo_tool", args: {} });
    await expect(promise).rejects.toThrow(/worker exited before resolving tool call "call-1"/);
  });

  // T031 — run-abort cancellation: aborting the caller's signal rejects the
  // pending waiter (distinct from a timeout) and tears down its listeners —
  // no unresolved promise is left pending on the worker.
  test("rejects with a cancellation error when the signal aborts before a reply arrives", async () => {
    const worker = new Worker(`const { parentPort } = require("node:worker_threads"); parentPort.on("message", () => {});`, {
      eval: true,
    });
    try {
      const controller = new AbortController();
      const promise = waitForToolResult(worker, "call-1", 5_000, controller.signal);
      sendToolCall(worker, { callId: "call-1", name: "echo_tool", args: {} });
      controller.abort();
      await expect(promise).rejects.toThrow(/cancelled/);
      expect(worker.listenerCount("message")).toBe(0);
      expect(worker.listenerCount("exit")).toBe(0);
    } finally {
      await worker.terminate();
    }
  });

  test("rejects immediately, without registering listeners, if the signal is already aborted", async () => {
    const worker = toolEchoWorker();
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(waitForToolResult(worker, "call-1", 5_000, controller.signal)).rejects.toThrow(/cancelled/);
      expect(worker.listenerCount("message")).toBe(0);
      expect(worker.listenerCount("exit")).toBe(0);
    } finally {
      await worker.terminate();
    }
  });

  // T031 — worker exit before reply is a distinct cancellation path from
  // run-abort; both must reject the waiter without leaking it.
  test("rejects if the worker exits before replying at all (never having received the call)", async () => {
    const worker = new Worker(`process.exit(0);`, { eval: true });
    await expect(waitForToolResult(worker, "call-1", 5_000)).rejects.toThrow(/worker exited before resolving tool call "call-1"/);
  });

  // T032 — callId isolation: two concurrent calls must never cross-talk, even
  // when the second call's reply arrives before the first's.
  test("two concurrent calls with distinct callIds resolve with their own result, no cross-talk", async () => {
    const worker = toolEchoWorker();
    try {
      const promiseA = waitForToolResult(worker, "call-a", 5_000);
      const promiseB = waitForToolResult(worker, "call-b", 5_000);
      sendToolCall(worker, { callId: "call-a", name: "echo_tool", args: { text: "A", delayMs: 50 } });
      sendToolCall(worker, { callId: "call-b", name: "echo_tool", args: { text: "B", delayMs: 5 } });

      const [resultA, resultB] = await Promise.all([promiseA, promiseB]);
      expect(resultA).toEqual({ callId: "call-a", result: "A" });
      expect(resultB).toEqual({ callId: "call-b", result: "B" });
    } finally {
      await worker.terminate();
    }
  });
});
