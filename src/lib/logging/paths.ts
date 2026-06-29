import "server-only";
import path from "node:path";
import { dataDir } from "@/os/data-dir";
import type { LogRecord } from "@/lib/logging/models/log-models";

// Shared layout helpers for the LOCAL (no-Supervisor dev) store, mirroring the
// Supervisor's tools/supervisor/log-store.mjs layout so the viewer reads the same
// shape. Under the Supervisor these aren't used (records ship over HTTP instead).

const MAX_LINE_BYTES = 64 * 1024;

export function logsDir(): string {
  // Prefer canonical data (shared across versions); fall back to this version's data.
  const canonical = process.env.BOS_CANONICAL_DATA?.trim();
  return path.join(canonical || dataDir(), "logs");
}

export function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "_";
}

function z(n: number): string {
  return String(n).padStart(2, "0");
}

export function dayFileName(ts: number): string {
  const d = new Date(ts);
  return `timeline-${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}.jsonl`;
}

export function recordLine(rec: LogRecord): string {
  let line: string;
  try {
    line = JSON.stringify(rec);
  } catch {
    line = JSON.stringify({ ts: rec.ts, level: "warn", stream: rec.stream, component: rec.component, msg: "[unserializable log record]" });
  }
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) line = line.slice(0, MAX_LINE_BYTES);
  return line + "\n";
}
