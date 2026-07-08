import "server-only";
import { LoggingService } from "@/lib/logging/services/logging-service";
import { HttpLogSink } from "@/lib/logging/sinks/http-log-sink";
import { FileLogSink } from "@/lib/logging/sinks/file-log-sink";
import type { LogSink } from "@/lib/logging/interface/log-sink";

// Composition root (dependency injection) for backend logging. The sink is chosen
// once from the environment: ship to the Supervisor when BOS_SUPERVISOR_URL is set,
// else write the local dev-fallback files.
let _sink: LogSink | null = null;
export function logSink(): LogSink {
  if (_sink) return _sink;
  const url = (process.env.BOS_SUPERVISOR_URL || "").trim();
  _sink = url ? new HttpLogSink(url) : new FileLogSink();
  return _sink;
}

let _logger: LoggingService | null = null;
export function logger(): LoggingService {
  return (_logger ??= new LoggingService(logSink()));
}
