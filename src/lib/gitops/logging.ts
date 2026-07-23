import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createWriteStream, type WriteStream } from "node:fs";
import { dataDir } from "@/os/data-dir";
import { logger } from "@/lib/logging";

// GitLogger — structured logger for all git operations. Writes JSONL to
// data/logs/git-ops.log with rotation, URL sanitization, and sensitive-data
// redaction. Also forwards warn+ to the central BOS logger so entries appear
// in the Logs viewer.

export type GitLogLevel = "debug" | "info" | "warn" | "error" | "critical";

export interface GitLogError {
  code: string;
  message: string;
  suggestion?: string;
}

export interface GitLogEntry {
  op: string;
  repoPath?: string;
  remote?: string;
  provider?: string;
  user?: string;
  durationMs?: number;
  success?: boolean;
  error?: GitLogError;
}

interface FullLogRecord {
  ts: string;
  level: GitLogLevel;
  op: string;
  repoPath?: string;
  remote?: string;
  provider?: string;
  user?: string;
  durationMs?: number;
  success?: boolean;
  error?: GitLogError;
}

// Sensitive field names that must never appear in log output.
const SENSITIVE_KEYS = new Set([
  "token", "tokens", "access_token", "refresh_token", "accessToken",
  "refreshToken", "pat", "password", "passphrase", "secret",
  "sshKey", "sshKeyData", "sshKeyPath", "privateKey", "private_key",
  "credentials", "authorization",
]);

// Regex matching URLs with embedded credentials (user:pass@host).
const URL_CREDENTIAL_RE = /(https?:\/\/)[^:]+:[^@]+@/gi;

// Max size per log file before rotation (10 MB).
const MAX_FILE_SIZE = 10 * 1024 * 1024;
// Retention period in ms (7 days).
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const CONSOLE_LEVELS: GitLogLevel[] = ["warn", "error", "critical"];
const LEVEL_ORDER: GitLogLevel[] = ["debug", "info", "warn", "error", "critical"];

function levelRank(l: GitLogLevel): number {
  return LEVEL_ORDER.indexOf(l);
}

function gitLogsDir(): string {
  return path.join(dataDir(), "logs");
}

function gitLogFile(): string {
  return path.join(gitLogsDir(), "git-ops.log");
}

function sanitizeUrl(url: string): string {
  return url.replace(URL_CREDENTIAL_RE, "$1****@");
}

function isSensitiveValue(v: unknown): boolean {
  if (typeof v !== "string") return false;
  // Reject keys that look like PEM-encoded data or long hex/base64 tokens.
  if (v.includes("BEGIN ") && v.includes("PRIVATE KEY")) return true;
  if (/^(ghp_|gho_|glpat-|xoxb-|xoxp-)/.test(v)) return true;
  return false;
}

function redactSensitiveStrings(obj: unknown): unknown {
  if (typeof obj === "string") {
    return sanitizeUrl(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(redactSensitiveStrings);
  }
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_KEYS.has(k)) {
        out[k] = "[REDACTED]";
      } else if (typeof v === "string") {
        out[k] = sanitizeUrl(v);
      } else if (typeof v === "object" && v !== null) {
        out[k] = redactSensitiveStrings(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  return obj;
}

function throwIfSensitive(entry: GitLogEntry): void {
  // Walk all values in the entry looking for tokens / keys / passphrases.
  for (const [k, v] of Object.entries(entry)) {
    if (SENSITIVE_KEYS.has(k) && v != null && v !== "") {
      throw new Error(
        `GitLogger: refusing to log sensitive field "${k}". Sensitive credentials must never appear in log entries.`,
      );
    }
    if (typeof v === "string" && isSensitiveValue(v)) {
      throw new Error(
        `GitLogger: refusing to log value that appears to be a token or private key (field "${k}").`,
      );
    }
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function fileSize(filePath: string): Promise<number> {
  try {
    const st = await fs.stat(filePath);
    return st.size;
  } catch {
    return 0;
  }
}

async function rotateIfNeeded(filePath: string): Promise<void> {
  const size = await fileSize(filePath);
  if (size < MAX_FILE_SIZE) return;

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveName = `git-ops.${ts}.log.gz`;
  const dir = path.dirname(filePath);
  const archivePath = path.join(dir, archiveName);

  try {
    // Simple rotation: rename current file, start a new one.
    // Compression would require zlib streaming; we rename with .gz suffix
    // as a marker for manual or cron-based compression.
    await fs.rename(filePath, archivePath);
  } catch {
    // If rename fails (file locked), just continue — we'll append.
  }
}

async function pruneOldArchives(dir: string): Promise<void> {
  try {
    const files = await fs.readdir(dir);
    const now = Date.now();
    for (const f of files) {
      if (!f.startsWith("git-ops.") || !f.endsWith(".log.gz")) continue;
      const fp = path.join(dir, f);
      try {
        const st = await fs.stat(fp);
        if (now - st.mtimeMs > RETENTION_MS) {
          await fs.rm(fp, { force: true });
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

const CONSOLE_LEVELS_SET = new Set(CONSOLE_LEVELS);

export class GitLogger {
  private stream: WriteStream | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private initialized = false;

  private get consoleLevel(): GitLogLevel {
    const env = (process.env.GITOPS_LOG_LEVEL || "warn").toLowerCase() as GitLogLevel;
    return LEVEL_ORDER.includes(env) ? env : "warn";
  }

  private shouldLogToConsole(level: GitLogLevel): boolean {
    return levelRank(level) >= levelRank(this.consoleLevel);
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    const dir = gitLogsDir();
    await ensureDir(dir);
    this.initialized = true;
  }

  private async writeRecord(record: FullLogRecord): Promise<void> {
    await this.init();

    const line = JSON.stringify(record) + "\n";
    const filePath = gitLogFile();

    await rotateIfNeeded(filePath);

    await new Promise<void>((resolve, reject) => {
      const s = createWriteStream(filePath, { flags: "a" });
      s.write(line, (err) => {
        s.end(() => {
          if (err) reject(err);
          else resolve();
        });
      });
    });

    // Prune old archives periodically (every ~100 writes).
    if (Math.random() < 0.01) {
      await pruneOldArchives(gitLogsDir());
    }
  }

  private emit(level: GitLogLevel, entry: GitLogEntry): void {
    // Validate: never log sensitive data.
    throwIfSensitive(entry);

    const record: FullLogRecord = {
      ts: new Date().toISOString(),
      level,
      op: entry.op,
      ...(entry.repoPath !== undefined ? { repoPath: entry.repoPath } : {}),
      ...(entry.remote !== undefined ? { remote: entry.remote } : {}),
      ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
      ...(entry.user !== undefined ? { user: entry.user } : {}),
      ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
      ...(entry.success !== undefined ? { success: entry.success } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    };

    // Fire-and-forget file write.
    this.writeQueue = this.writeQueue.then(() => this.writeRecord(record)).catch(() => {});
    // Don't block caller.
    void this.writeQueue;

    // Forward warn+ to central BOS logger.
    if (this.shouldLogToConsole(level)) {
      const centralLevel = level === "critical" ? "error" : level;
      const data = redactSensitiveStrings({
        op: entry.op,
        repoPath: entry.repoPath,
        remote: entry.remote,
        provider: entry.provider,
        user: entry.user,
        durationMs: entry.durationMs,
        success: entry.success,
        error: entry.error,
      });
      logger()[centralLevel]("gitops", entry.error?.message ?? entry.op, data);
    }
  }

  debug(entry: GitLogEntry): void {
    this.emit("debug", entry);
  }

  info(entry: GitLogEntry): void {
    this.emit("info", entry);
  }

  warn(entry: GitLogEntry): void {
    this.emit("warn", entry);
  }

  error(entry: GitLogEntry): void {
    this.emit("error", entry);
  }

  critical(entry: GitLogEntry): void {
    this.emit("critical", entry);
  }

  /** Flush any buffered writes (for graceful shutdown). */
  async flush(): Promise<void> {
    await this.writeQueue;
  }
}

// Singleton for the gitops layer.
let _instance: GitLogger | undefined;

export function gitLogger(): GitLogger {
  return (_instance ??= new GitLogger());
}

// Export helpers for testing.
export { sanitizeUrl as _sanitizeUrl, redactSensitiveStrings as _redactSensitiveStrings, throwIfSensitive as _throwIfSensitive, CONSOLE_LEVELS_SET, LEVEL_ORDER };
