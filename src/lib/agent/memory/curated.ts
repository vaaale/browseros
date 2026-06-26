import "server-only";
import { promises as fs } from "fs";
import path from "path";

// Curated, bounded, file-backed memory — the always-injected core (spec/memory.md).
// Two surfaces:
//   USER.md   — who the user is: identity, role, durable preferences, style, expectations.
//   MEMORY.md — the assistant's notes: environment facts, conventions, tool quirks, lessons.
// Entries are short declarative statements joined by a § delimiter. Each surface
// has a character budget (model-independent); writes that would overflow are
// rejected so the agent must consolidate rather than grow without bound.

const DIR = path.join(process.cwd(), "data", "memory");
const DELIM = "\n§\n";

export type MemoryTarget = "user" | "memory";

const FILES: Record<MemoryTarget, string> = { user: "USER.md", memory: "MEMORY.md" };
// Small on purpose — forces high-signal, consolidated entries.
export const LIMITS: Record<MemoryTarget, number> = { user: 1200, memory: 2000 };

export interface MemoryResult {
  success: boolean;
  message?: string;
  error?: string;
  /** "<pct>% — <current>/<limit> chars" after the operation. */
  usage?: string;
  /** Returned only on the error/over-budget path, so the model can consolidate. */
  entries?: string[];
}

export interface MemoryOp {
  action: "add" | "replace" | "remove";
  content?: string;
  oldText?: string;
}

// Lightweight injection/exfiltration scan. Memory enters the system prompt and
// persists across sessions, so a poisoned entry is high-impact; reject obvious
// prompt-injection patterns at write time.
const THREAT_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|the\s+|your\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(the\s+|all\s+)?(above|previous|prior)/i,
  /\bsystem\s+prompt\b/i,
  /\bexfiltrat/i,
  /<\s*\/?\s*(system|tool_call|tool_result)\s*>/i,
];

function scanThreat(content: string): string | null {
  for (const re of THREAT_PATTERNS) {
    if (re.test(content)) return `Refused: entry matched a prompt-injection pattern (${re.source}). Rephrase it.`;
  }
  return null;
}

function fileFor(target: MemoryTarget): string {
  return path.join(DIR, FILES[target]);
}

function parse(raw: string): string[] {
  if (!raw.trim()) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of raw.split(DELIM).map((s) => s.trim())) {
    if (e && !seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  }
  return out;
}

async function readEntries(target: MemoryTarget): Promise<string[]> {
  try {
    return parse(await fs.readFile(fileFor(target), "utf8"));
  } catch {
    return [];
  }
}

async function writeEntries(target: MemoryTarget, entries: string[]): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  const dest = fileFor(target);
  const tmp = path.join(DIR, `.${FILES[target]}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, entries.join(DELIM), "utf8");
  await fs.rename(tmp, dest);
}

function charCount(entries: string[]): number {
  return entries.length ? entries.join(DELIM).length : 0;
}

function usageStr(entries: string[], limit: number): string {
  const c = charCount(entries);
  const pct = limit > 0 ? Math.min(100, Math.round((c / limit) * 100)) : 0;
  return `${pct}% — ${c.toLocaleString()}/${limit.toLocaleString()} chars`;
}

// Serialize all writes per target so concurrent API calls can't clobber each
// other (read-modify-write). Node is single-threaded but awaits interleave.
const locks: Record<MemoryTarget, Promise<unknown>> = { user: Promise.resolve(), memory: Promise.resolve() };
function withLock<T>(target: MemoryTarget, fn: () => Promise<T>): Promise<T> {
  const run = locks[target].then(fn, fn);
  locks[target] = run.then(() => undefined, () => undefined);
  return run;
}

export async function listEntries(target: MemoryTarget): Promise<string[]> {
  return readEntries(target);
}

/** Build the matching helper for replace/remove: find entries containing oldText. */
function matchIndices(entries: string[], oldText: string): number[] {
  return entries.map((e, i) => (e.includes(oldText) ? i : -1)).filter((i) => i >= 0);
}

function applyOps(entries: string[], ops: MemoryOp[]): { entries?: string[]; error?: string } {
  const working = [...entries];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const pos = `Operation ${i + 1} (${op.action})`;
    if (op.action === "add") {
      const content = (op.content ?? "").trim();
      if (!content) return { error: `${pos}: content is required.` };
      const threat = scanThreat(content);
      if (threat) return { error: `${pos}: ${threat}` };
      if (!working.includes(content)) working.push(content);
    } else if (op.action === "replace") {
      const oldText = (op.oldText ?? "").trim();
      const content = (op.content ?? "").trim();
      if (!oldText) return { error: `${pos}: oldText is required.` };
      if (!content) return { error: `${pos}: content is required (use remove to delete).` };
      const threat = scanThreat(content);
      if (threat) return { error: `${pos}: ${threat}` };
      const m = matchIndices(working, oldText);
      if (m.length === 0) return { error: `${pos}: no entry matched "${oldText}".` };
      if (new Set(m.map((j) => working[j])).size > 1) return { error: `${pos}: "${oldText}" matched multiple distinct entries — be more specific.` };
      working[m[0]] = content;
    } else if (op.action === "remove") {
      const oldText = (op.oldText ?? "").trim();
      if (!oldText) return { error: `${pos}: oldText is required.` };
      const m = matchIndices(working, oldText);
      if (m.length === 0) return { error: `${pos}: no entry matched "${oldText}".` };
      if (new Set(m.map((j) => working[j])).size > 1) return { error: `${pos}: "${oldText}" matched multiple distinct entries — be more specific.` };
      working.splice(m[0], 1);
    } else {
      return { error: `${pos}: unknown action. Use add, replace, or remove.` };
    }
  }
  return { entries: working };
}

/** Apply one or more operations to a target atomically against the FINAL budget. */
export async function applyBatch(target: MemoryTarget, ops: MemoryOp[]): Promise<MemoryResult> {
  if (!ops.length) return { success: false, error: "No operations provided." };
  return withLock(target, async () => {
    const current = await readEntries(target);
    const { entries: next, error } = applyOps(current, ops);
    if (error || !next) {
      return { success: false, error: error ?? "Could not apply operations.", entries: current, usage: usageStr(current, LIMITS[target]) };
    }
    const limit = LIMITS[target];
    if (charCount(next) > limit) {
      return {
        success: false,
        error: `Over budget (${charCount(next).toLocaleString()}/${limit.toLocaleString()} chars). Remove or shorten entries in the same call, then retry — consolidate overlapping entries.`,
        entries: current,
        usage: usageStr(current, limit),
      };
    }
    await writeEntries(target, next);
    return { success: true, message: `Applied ${ops.length} operation(s).`, usage: usageStr(next, limit) };
  });
}

export function addEntry(target: MemoryTarget, content: string): Promise<MemoryResult> {
  return applyBatch(target, [{ action: "add", content }]);
}
export function replaceEntry(target: MemoryTarget, oldText: string, content: string): Promise<MemoryResult> {
  return applyBatch(target, [{ action: "replace", oldText, content }]);
}
export function removeEntry(target: MemoryTarget, oldText: string): Promise<MemoryResult> {
  return applyBatch(target, [{ action: "remove", oldText }]);
}

function renderBlock(target: MemoryTarget, entries: string[]): string {
  if (!entries.length) return "";
  const header = target === "user" ? "USER PROFILE — who the user is" : "MEMORY — your notes";
  return `### ${header} [${usageStr(entries, LIMITS[target])}]\n${entries.join(DELIM)}`;
}

/**
 * The frozen snapshot injected into the assistant's system instructions.
 * Returns "" when both surfaces are empty. Built fresh each session (the caller
 * composes instructions once per session, keeping the prompt stable thereafter).
 */
export async function memorySnapshot(): Promise<string> {
  const [user, memory] = await Promise.all([readEntries("user"), readEntries("memory")]);
  const blocks = [renderBlock("user", user), renderBlock("memory", memory)].filter(Boolean);
  if (!blocks.length) return "";
  return `## Memory (persistent across sessions)\nThese are durable notes. Honor them; do not ask the user to repeat what is here.\n\n${blocks.join("\n\n")}`;
}
