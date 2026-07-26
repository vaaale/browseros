// workerIpc: postMessage / waitForMessage — real worker_threads (eval:true
// inline scripts, no fixture files needed since these don't go through
// ServiceManager's file-path-based Worker construction).
//   npx playwright test -c playwright.unit.config.ts tests/services/workerIpc.test.ts
import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import { Worker } from "node:worker_threads";
import { postMessage, waitForMessage } from "../../src/core/service/workerIpc";

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
