import fs from "fs";
import path from "path";

let _dataDir = "";

export function initLogStore(dataDir: string): void {
  _dataDir = dataDir;
}

function logFile(username: string): string {
  return path.join(_dataDir, "logs", `${username}.log`);
}

export function append(username: string, line: string): void {
  if (!_dataDir) return;
  const dir = path.join(_dataDir, "logs");
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(logFile(username), `[${new Date().toISOString()}] ${line}\n`);
}

export function read(username: string, opts?: { tail?: number }): string {
  const f = logFile(username);
  if (!fs.existsSync(f)) return "";
  const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  if (opts?.tail && opts.tail < lines.length) return lines.slice(-opts.tail).join("\n");
  return lines.join("\n");
}

export function deleteLog(username: string): void {
  const f = logFile(username);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
