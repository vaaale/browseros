import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

// Request-scoped logging context. A route handler enters it once (with the request's
// browser session id), and any core function logging via the LoggingService inherits
// the sessionId/versionLabel WITHOUT having to thread them through its signature.
export interface LogContext {
  sessionId?: string;
  versionLabel?: string;
  component?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getLogContext(): LogContext {
  return storage.getStore() ?? {};
}

// The role of THIS version server, set by the Supervisor (base|preview); "dev" when
// BOS runs outside the Supervisor.
export function currentVersionLabel(): string {
  return process.env.BOS_VERSION_LABEL || "dev";
}
