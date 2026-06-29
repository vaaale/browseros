import "server-only";
import type { LogSink } from "@/lib/logging/interface/log-sink";
import type { LogRecord } from "@/lib/logging/models/log-models";

// Ships records to the always-on Supervisor sink (POST /__supervisor/logs). Used
// whenever BOS runs under the Supervisor (BOS_SUPERVISOR_URL set). A short timeout
// keeps a wedged kernel from blocking the caller; the LoggingService re-buffers on
// failure so a brief promote/discard swap doesn't lose records.
export class HttpLogSink implements LogSink {
  private readonly endpoint: string;

  constructor(baseUrl: string) {
    this.endpoint = `${baseUrl.replace(/\/$/, "")}/__supervisor/logs`;
  }

  async ship(records: LogRecord[]): Promise<void> {
    if (records.length === 0) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
