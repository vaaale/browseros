import "server-only";
import { spawn } from "node:child_process";
import path from "node:path";

// Native bash tool for the assistant. Runs `bash -lc <command>` so the assistant
// can use shell syntax (pipes, redirects, subshells) directly. Safety comes from:
//  - a Settings toggle (see src/lib/config/registry.ts "system-tools") — off by default
//  - per-call timeout (default 120s, max 600s)
//  - output buffer cap (~8MB collected, truncated to ~16KB in the result)
// No command allowlist: the user opts in via Settings and owns the risk.

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
const MAX_COLLECT_BYTES = 8 * 1024 * 1024; // hard cap on what we buffer in memory
const TRUNCATE_TO_BYTES = 16 * 1024; // keep the tail this large in the result
const TRUNC_MARKER = "\n[truncated]\n";

export interface BashResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  command: string;
  timedOut?: boolean;
  signal?: string | null;
  cwd: string;
}

function truncate(buf: Buffer): string {
  if (buf.length <= TRUNCATE_TO_BYTES) return buf.toString("utf8");
  const tail = buf.subarray(buf.length - TRUNCATE_TO_BYTES);
  return TRUNC_MARKER + tail.toString("utf8");
}

/**
 * Run a shell command via `bash -lc`. Resolves once the process exits (or is
 * killed by the timeout). Never throws for a non-zero exit — callers get
 * `ok: false` with the captured output.
 */
export async function runBash(
  command: string,
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<BashResult> {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const timeoutMs = Math.max(1_000, Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  const started = Date.now();

  return await new Promise<BashResult>((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd, env: process.env });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;

    const collect = (chunks: Buffer[], data: Buffer, current: number, which: "stdout" | "stderr") => {
      const remaining = MAX_COLLECT_BYTES - current;
      if (remaining <= 0) return current;
      if (data.length <= remaining) {
        chunks.push(data);
        return current + data.length;
      }
      chunks.push(data.subarray(0, remaining));
      // Once we've hit the cap on this stream, kill the child so we don't OOM
      // if it keeps writing megabytes.
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      void which;
      return current + remaining;
    };

    child.stdout.on("data", (d: Buffer) => {
      stdoutBytes = collect(stdoutChunks, d, stdoutBytes, "stdout");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderrBytes = collect(stderrChunks, d, stderrBytes, "stderr");
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      // Escalate if the process ignores SIGTERM.
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 2_000).unref();
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        stdout: truncate(Buffer.concat(stdoutChunks)),
        stderr: (err as Error).message,
        durationMs: Date.now() - started,
        command,
        timedOut,
        signal: null,
        cwd,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stdout = truncate(Buffer.concat(stdoutChunks));
      const stderrBuf = Buffer.concat(stderrChunks);
      let stderr = truncate(stderrBuf);
      if (timedOut) {
        stderr = (stderr ? stderr + "\n" : "") + `[timed out after ${timeoutMs}ms]`;
      }
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        command,
        timedOut: timedOut || undefined,
        signal: signal ?? null,
        cwd,
      });
    });
  });
}
