// Domain models for the central logging system (specs/017-central-logging).
// Pure types only (no runtime, no server-only) so both server and client may import
// them for type-safety.

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Source of a record. A FIELD used to filter a timeline — never a separate file. */
export type LogStream = "frontend" | "backend" | "supervisor";

export interface LogErr {
  message: string;
  stack?: string;
}

/** What a caller supplies. Context fields (sessionId/versionLabel/ts) are optional
 *  and filled in by the LoggingService from request-scoped context when omitted. */
export interface LogRecordInput {
  level: LogLevel;
  component: string;
  conversation?: string;
  msg: string;
  data?: unknown;
  err?: LogErr;
  branch?: string;
  stream?: LogStream;
  sessionId?: string;
  versionLabel?: string;
  ts?: number;
}

/** A fully-formed record as written to / read from the store. */
export interface LogRecord {
  ts: number;
  level: LogLevel;
  stream: LogStream;
  component: string;
  conversation?: string;
  msg: string;
  data?: unknown;
  err?: LogErr;
  branch?: string;
  sessionId?: string;
  versionLabel?: string;
  /** Server receipt time, stamped by the sink (clock-skew guard). */
  rxts?: number;
  /** Relative path of a referenced build-log blob, when applicable. */
  buildLog?: string;
}

/** Filter for reading a timeline (global, or a single session). */
export interface LogQuery {
  session?: string;
  stream?: LogStream;
  level?: LogLevel;
  component?: string;
  conversation?: string;
  since?: number;
  limit?: number;
}

/** A session partition's summary (for the viewer's session picker). */
export interface LogSessionSummary {
  id: string;
  size: number;
  mtime: number;
}
