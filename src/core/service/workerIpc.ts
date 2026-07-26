import "server-only";
import type { Worker } from "node:worker_threads";
import type { MainToWorkerMessage, WorkerToMainMessage } from "./types";

/** Send a message to a service worker thread. */
export function postMessage(worker: Worker, message: MainToWorkerMessage): void {
  worker.postMessage(message);
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
