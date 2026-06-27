import "server-only";
import { execFile } from "node:child_process";

// Lets the developer sub-agent verify its own edits, but ONLY via a fixed
// allowlist mapped to exact argv. Commands run with execFile (no shell), so the
// agent cannot inject arguments or run anything outside this map.
const COMMANDS: Record<string, { argv: [string, string[]]; timeoutMs: number; description: string }> = {
  typecheck: { argv: ["npx", ["tsc", "--noEmit"]], timeoutMs: 120_000, description: "TypeScript type check" },
  lint: { argv: ["npx", ["eslint", "."]], timeoutMs: 120_000, description: "ESLint" },
  build: { argv: ["npm", ["run", "build"]], timeoutMs: 300_000, description: "Production build" },
  e2e: { argv: ["npm", ["run", "test:e2e"]], timeoutMs: 600_000, description: "Playwright end-to-end tests" },
};

export const ALLOWED_COMMANDS = Object.keys(COMMANDS);

export interface CommandResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  output: string;
}

const MAX_OUTPUT = 16 * 1024;

function clip(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n…[output truncated]" : s;
}

export async function runDevCommand(name: string): Promise<CommandResult> {
  const spec = COMMANDS[name];
  if (!spec) {
    throw new Error(`Command "${name}" is not allowed. Allowed: ${ALLOWED_COMMANDS.join(", ")}.`);
  }
  const [cmd, args] = spec.argv;
  return new Promise<CommandResult>((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: process.cwd(), timeout: spec.timeoutMs, maxBuffer: 8 * 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        const output = clip([stdout, stderr].filter(Boolean).join("\n").trim() || "(no output)");
        const exitCode = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
        resolve({ command: name, ok: !err, exitCode, output });
      },
    );
  });
}
