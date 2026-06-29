import "server-only";

// Public API of the backend logging module (specs/017-central-logging).
// Core src/lib functions should import from here:
//
//   import { logger, withLogContext } from "@/lib/logging";
//   logger().info("apps.build", "installed app", { id });
//
// Request handlers enter a context once so emitted records carry the session id:
//   return withLogContext({ sessionId }, () => handle(req));

export type {
  LogLevel,
  LogStream,
  LogRecord,
  LogRecordInput,
  LogQuery,
  LogSessionSummary,
  LogErr,
} from "@/lib/logging/models/log-models";

export { logger, logSink } from "@/lib/logging/server-logger";
export { withLogContext, getLogContext, currentVersionLabel } from "@/lib/logging/context";
export type { LogContext } from "@/lib/logging/context";
