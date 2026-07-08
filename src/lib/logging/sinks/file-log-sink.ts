import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { LogSink } from "@/lib/logging/interface/log-sink";
import type { LogRecord } from "@/lib/logging/models/log-models";
import { logsDir, safeName, dayFileName, recordLine } from "@/lib/logging/paths";

// Dev fallback used only when no Supervisor is present. Writes the same timeline +
// per-session layout locally so the Logs viewer still works. Appends are serialized
// through one queue (single process) so lines never interleave.
export class FileLogSink implements LogSink {
  private queue: Promise<void> = Promise.resolve();

  async ship(records: LogRecord[]): Promise<void> {
    if (records.length === 0) return;
    this.queue = this.queue.then(() => this.write(records)).catch(() => {});
    return this.queue;
  }

  private async write(records: LogRecord[]): Promise<void> {
    const dir = logsDir();
    const sessionsDir = path.join(dir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    for (const rec of records) {
      const ts = typeof rec.ts === "number" ? rec.ts : Date.now();
      const line = recordLine({ ...rec, ts, rxts: Date.now() });
      await fs.appendFile(path.join(dir, dayFileName(ts)), line);
      if (rec.sessionId) {
        await fs.appendFile(path.join(sessionsDir, safeName(rec.sessionId) + ".jsonl"), line);
      }
    }
  }
}
