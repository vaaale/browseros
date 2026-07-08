import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { logsDir, safeName } from "@/lib/logging/paths";
import type { LogQuery, LogRecord, LogSessionSummary } from "@/lib/logging/models/log-models";

// Reads the LOCAL dev-fallback store for the Logs viewer when no Supervisor is
// present. Under the Supervisor, /api/logs forwards reads to it instead.
const LEVELS = ["debug", "info", "warn", "error"];

export async function readLocalLogs(q: LogQuery): Promise<LogRecord[]> {
  const dir = logsDir();
  let files: string[];
  if (q.session) {
    files = [path.join(dir, "sessions", safeName(q.session) + ".jsonl")];
  } else {
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    files = entries
      .filter((f) => f.startsWith("timeline-") && f.endsWith(".jsonl"))
      .sort()
      .slice(-7)
      .map((f) => path.join(dir, f));
  }
  const minLevel = q.level ? LEVELS.indexOf(q.level) : 0;
  const out: LogRecord[] = [];
  for (const f of files) {
    let content: string;
    try {
      content = await fs.readFile(f, "utf8");
    } catch {
      continue;
    }
    for (const ln of content.split("\n")) {
      if (!ln) continue;
      let rec: LogRecord;
      try {
        rec = JSON.parse(ln) as LogRecord;
      } catch {
        continue;
      }
      if (q.stream && rec.stream !== q.stream) continue;
      if (minLevel > 0 && LEVELS.indexOf(rec.level) < minLevel) continue;
      if (q.component && !rec.component.toLowerCase().includes(q.component.toLowerCase())) continue;
      if (q.conversation && !(rec.conversation ?? "").toLowerCase().includes(q.conversation.toLowerCase())) continue;
      if (q.since && rec.ts < q.since) continue;
      out.push(rec);
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  const limit = q.limit && q.limit > 0 ? q.limit : 1000;
  return out.slice(-limit);
}

export async function listLocalSessions(): Promise<LogSessionSummary[]> {
  const dir = path.join(logsDir(), "sessions");
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: LogSessionSummary[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    const st = await fs.stat(path.join(dir, e.name)).catch(() => null);
    if (st) out.push({ id: e.name.replace(/\.jsonl$/, ""), size: st.size, mtime: st.mtimeMs });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}
