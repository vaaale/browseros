import "server-only";
import type { Worker } from "node:worker_threads";
import type { EventDispatchPayload, MainToWorkerMessage, WorkerToMainMessage } from "./types";
import type { ToolInvocation, ToolInvocationResult } from "./serviceToolTypes";

/** Send a message to a service worker thread. */
export function postMessage(worker: Worker, message: MainToWorkerMessage): void {
  worker.postMessage(message);
}

/** Dispatch a tool invocation to the worker (Main→Worker `tool_call`). Pairs
 *  with `waitForToolResult`, which the caller must set up to correlate the
 *  eventual `tool_result`/`tool_error` by `callId` (039-service-tool-exposure). */
export function sendToolCall(worker: Worker, invocation: ToolInvocation): void {
  postMessage(worker, { type: "tool_call", payload: invocation });
}

/** Dispatch a headless-handler invocation to the worker (Main→Worker
 *  `event_dispatch`, 034-event-notification-system T028). Fire-and-forget:
 *  the worker acks asynchronously over loopback HTTP, not on this channel. */
export function sendEventDispatch(worker: Worker, payload: EventDispatchPayload): void {
  postMessage(worker, { type: "event_dispatch", payload });
}

/** Distinguishes *why* a pending `waitForToolResult` waiter rejected, without
 *  callers having to pattern-match the error message text — `ServiceToolBridge
 *  .invoke` (039-service-tool-exposure T035) uses this to log `tool_call:
 *  timeout`/`tool_call:cancelled` (warn) vs `tool_call:error` (error). */
export type ToolCallFailureCode = "timeout" | "cancelled" | "worker_exit";

function toolCallFailure(code: ToolCallFailureCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Resolve when the worker sends a `tool_result`/`tool_error` whose payload
 * `callId` matches, reject on timeout, worker exit, or the caller's `signal`
 * aborting (run abort/cancellation) — keyed by `callId` (not bare type match)
 * so concurrent tool calls never cross-talk (R2). Every settle path clears the
 * timer and removes all listeners (message/exit/abort) so no waiter leaks
 * (R10) — mirrors `waitForMessage`'s cleanup/timeout semantics.
 */
export function waitForToolResult(
  worker: Worker,
  callId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ToolInvocationResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(toolCallFailure("cancelled", `tool call "${callId}" cancelled (run aborted)`));
      return;
    }

    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
    };
    const onMessage = (msg: WorkerToMainMessage) => {
      if (msg.type !== "tool_result" && msg.type !== "tool_error") return;
      if (msg.payload.callId !== callId) return;
      cleanup();
      resolve(msg.payload);
    };
    const onExit = () => {
      cleanup();
      reject(toolCallFailure("worker_exit", `worker exited before resolving tool call "${callId}"`));
    };
    const onAbort = () => {
      cleanup();
      reject(toolCallFailure("cancelled", `tool call "${callId}" cancelled (run aborted)`));
    };

    worker.on("message", onMessage);
    worker.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        cleanup();
        reject(toolCallFailure("timeout", `timed out waiting for tool call "${callId}" after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

/**
 * Resolve when the worker sends a message of the given `type`, reject on
 * timeout or if the worker exits first. Callers implementing CH-015's
 * "timeout of 0 disables waiting" MUST skip calling this entirely rather than
 * passing 0 — this helper always waits (bounded by `timeoutMs`, which must be
 * a positive number).
 */
export function waitForMessage<T extends WorkerToMainMessage["type"]>(
  worker: Worker,
  type: T,
  timeoutMs: number,
): Promise<Extract<WorkerToMainMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
    };
    const onMessage = (msg: WorkerToMainMessage) => {
      if (msg.type !== type) return;
      cleanup();
      resolve(msg as Extract<WorkerToMainMessage, { type: T }>);
    };
    const onExit = () => {
      cleanup();
      reject(new Error(`worker exited before sending "${type}"`));
    };

    worker.on("message", onMessage);
    worker.once("exit", onExit);

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for "${type}" after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
    }
  });
}
