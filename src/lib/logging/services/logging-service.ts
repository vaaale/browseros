import "server-only";
import type { LogSink } from "@/lib/logging/interface/log-sink";
import type { LogRecord, LogRecordInput } from "@/lib/logging/models/log-models";
import { getLogContext, currentVersionLabel } from "@/lib/logging/context";

// Backend logging entry point that core src/lib functions call. Buffers records and
// ships them to the configured sink in batches. It is FIRE-AND-FORGET: it never
// throws into caller code and never blocks a request. Request-scoped sessionId /
// versionLabel are pulled from AsyncLocalStorage so callers don't thread them.
const FLUSH_INTERVAL_MS = 1_500;
const MAX_BUFFER = 500;

export class LoggingService {
  private buffer: LogRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly sink: LogSink) {}

  log(input: LogRecordInput): void {
    try {
      const ctx = getLogContext();
      const sessionId = input.sessionId ?? ctx.sessionId;
      const rec: LogRecord = {
        ts: input.ts ?? Date.now(),
        level: input.level,
        stream: input.stream ?? "backend",
        component: input.component || ctx.component || "",
        ...(input.conversation ? { conversation: input.conversation } : {}),
        msg: input.msg,
        ...(input.data !== undefined ? { data: input.data } : {}),
        ...(input.err ? { err: input.err } : {}),
        ...(input.branch ? { branch: input.branch } : {}),
        ...(sessionId ? { sessionId } : {}),
        versionLabel: input.versionLabel ?? ctx.versionLabel ?? currentVersionLabel(),
      };
      this.buffer.push(rec);
      if (this.buffer.length >= MAX_BUFFER) void this.flush();
      else this.schedule();
    } catch {
      /* logging must never throw into the caller */
    }
  }

  debug(component: string, msg: string, data?: unknown): void {
    this.log({ level: "debug", component, msg, data });
  }
  info(component: string, msg: string, data?: unknown): void {
    this.log({ level: "info", component, msg, data });
  }
  warn(component: string, msg: string, data?: unknown): void {
    this.log({ level: "warn", component, msg, data });
  }
  error(component: string, msg: string, err?: unknown, data?: unknown): void {
    this.log({ level: "error", component, msg, data, err: toErr(err) });
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS);
    // Don't keep the process alive just to flush logs.
    (this.timer as { unref?: () => void }).unref?.();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.sink.ship(batch);
    } catch {
      // Re-buffer a bounded tail so a transient sink outage (e.g. a promote/discard
      // server swap) loses as little as possible rather than the whole batch.
      this.buffer = [...batch, ...this.buffer].slice(-MAX_BUFFER);
    }
  }
}

function toErr(err: unknown): { message: string; stack?: string } | undefined {
  if (err === undefined || err === null) return undefined;
  if (err instanceof Error) return { message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
  if (typeof err === "object") {
    const o = err as { message?: unknown; stack?: unknown };
    const message = typeof o.message === "string" && o.message ? o.message : safeStringify(err);
    const stack = typeof o.stack === "string" ? o.stack : undefined;
    return stack ? { message, stack } : { message };
  }
  return { message: String(err) };
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
