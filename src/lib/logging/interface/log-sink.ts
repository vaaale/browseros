import "server-only";
import type { LogRecord } from "@/lib/logging/models/log-models";

// A LogSink ships backend/ingested records to the central store. Under the
// Supervisor that is an HTTP hop to the always-on kernel; in no-Supervisor dev it
// is a local file. Implementations MUST be fire-and-forget safe — never throw into
// caller code (the LoggingService still guards, but sinks should resolve quietly).
export interface LogSink {
  ship(records: LogRecord[]): Promise<void>;
}
