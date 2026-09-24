import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import { transcriptEnabled } from "@/lib/config/registry";
import { logger } from "@/lib/logging";

// Durable per-run transcription for HEADLESS agent runs (031-self-healing
// scope-add, FR-029/FR-030/FR-031/FR-037, design ADR-10).
//
// Two files per run, written in lockstep:
//     data/agent-transcripts/<agentId>/<runId>.md      — human-readable audit artifact
//     data/agent-transcripts/<agentId>/<runId>.ndjson  — lossless structured companion (FR-037)
//
// The markdown flattens each event to one scannable line, which makes it LOSSY
// (a tool call becomes `name(input)` text). The .ndjson keeps the structured
// form — one JSON entry per line, appended at the same per-turn cadence — so
// the Self-Heal pane can render the run as a real conversation (ChatMarkdown +
// ToolCallCard, FR-031) instead of a <pre> dump. NDJSON rather than a JSON
// array because it shares the markdown's append-only write pattern: no
// rewrite-the-array bookkeeping, and a crash mid-append costs one torn line,
// not the file.
//
// Why here and not in each caller: transcription is a PLATFORM capability. Both
// headless entry points (`runLocalHeadless` in runner.ts, `runClaudeAgent` in
// claude-runner.ts) already process the run's full event stream, so this writer
// is a side-channel observer on that existing stream — it reads what the runner
// already has, writes a file, and returns nothing. Every headless caller
// (scheduler, Telegram, workflow steps, /api/subagents/delegate, self-heal) gets
// a transcript without knowing this module exists.
//
// Three properties are load-bearing, because `runLocalHeadless` is a SHARED path:
//   1. **Config-gated.** `agentRuns.transcriptions.enabled` false ⇒ `open()`
//      marks the writer disabled and every method is a no-op.
//   2. **Never throws.** A transcript is an artifact, not part of the run's
//      contract: the first I/O failure disables the writer and is logged once.
//   3. **Per-turn cadence.** One `appendFile` per event line, never per
//      reasoning delta (that would be one write per token on a shared path).
//
// It is deliberately NOT the VFS: `data/agent-transcripts/` is a sibling of it,
// so a transcript can never appear in the Chats app, the Diagnostician's
// idle-conversation review, or memory curation (FR-030). The only reader is the
// read-only GET /api/agent-transcripts route.

const COMPONENT = "subagents.transcript";

/** Bounds. A transcript is something a human SCANS, so every field is clipped:
 *  the full tool result is in the run's own log, not here. */
const MAX_TASK = 2_000;
const MAX_INPUT = 400;
const MAX_RESULT = 300;
const MAX_TEXT = 600;

/** The .ndjson bound is far looser than the markdown's: the structured file is
 *  RENDERED, not scanned, so it keeps full text and args — clipped only so one
 *  pathological tool result cannot write an unbounded file. */
const MAX_JSON_FIELD = 20_000;

export type TranscriptStatus = "in-flight" | "completed" | "aborted";
export type TranscriptKind = "local" | "claude";

/** One line of the structured companion (FR-037). `tool_call`/`tool_result`
 *  pair by `callId`; a call whose result never arrived is still running (or the
 *  run died — the reader decides from the run's status). */
export type TranscriptEntry =
  | { type: "task_input"; text: string }
  | { type: "assistant_text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; callId: string; name: string; args: unknown; status: "running" }
  | { type: "tool_result"; callId: string; name: string; status: "ok" | "error"; result: string };

export interface TranscriptSummary {
  runId: string;
  agentId: string;
  agentName?: string;
  status: TranscriptStatus;
  startedAt?: string;
  endedAt?: string;
  caseId?: string;
  parentRunId?: string;
}

export interface TranscriptDocument extends TranscriptSummary {
  markdown: string;
}

/** The transcripts root. Resolved per call, never captured at module scope:
 *  `dataDir()` is env-driven (`BOS_DATA_DIR`), so a preview's data clone gets
 *  its own transcripts for free. */
export function transcriptsDir(): string {
  return path.join(dataDir(), "agent-transcripts");
}

/** One path component, safe to join. A runId/agentId is generated internally,
 *  but it is composed from an agent id that ultimately came from disk — so it is
 *  sanitized rather than trusted. */
function segment(raw: string): string {
  const clean = (raw || "unknown").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  return clean || "unknown";
}

export function transcriptPathFor(agentId: string, runId: string): string {
  return path.join(transcriptsDir(), segment(agentId), `${segment(runId)}.md`);
}

/** The structured companion sits beside the markdown, same name (FR-037). */
export function transcriptJsonPathFor(agentId: string, runId: string): string {
  return path.join(transcriptsDir(), segment(agentId), `${segment(runId)}.ndjson`);
}

function truncate(text: string, max: number): string {
  const clean = (text ?? "").replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/** Bound WITHOUT flattening: the .ndjson feeds a markdown renderer, so
 *  newlines are load-bearing there (unlike the one-line markdown timeline). */
function clip(text: string, max: number): string {
  const s = text ?? "";
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** A tool's args for the structured entry: the real object when it survives a
 *  JSON round-trip inside the bound, its string form otherwise. */
function jsonArgs(input: unknown): unknown {
  try {
    const raw = JSON.stringify(input ?? {});
    return raw.length <= MAX_JSON_FIELD ? (JSON.parse(raw) as unknown) : clip(raw, MAX_JSON_FIELD);
  } catch {
    return truncate(String(input), MAX_INPUT);
  }
}

/** Compact JSON for a tool input, bounded. Unserializable input degrades to its
 *  string form rather than losing the line. */
function compactInput(input: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(input ?? {});
  } catch {
    raw = String(input);
  }
  return truncate(raw, MAX_INPUT);
}

/** `[mm:ss.d]` since the run started. Absolute times live in the frontmatter;
 *  a wall of lines is far more readable relative. */
function stamp(elapsedMs: number): string {
  const total = Math.max(0, elapsedMs) / 1000;
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(Math.floor(total % 60)).padStart(2, "0");
  const tenths = Math.floor((total * 10) % 10);
  return `[${mm}:${ss}.${tenths}]`;
}

// ── Frontmatter ─────────────────────────────────────────────────────────────

/** The frontmatter keys, in the order they are rendered. `endedAt`/`aborted`
 *  are deliberately ABSENT while a run is in flight — that absence is what makes
 *  the in-flight file readable "up to the present" (FR-031) and is exactly what
 *  `statusOf` reads. */
const FRONTMATTER_ORDER = ["agentId", "agentName", "runId", "startedAt", "kind", "parentRunId", "caseId", "endedAt", "aborted"] as const;

const QUOTED_KEYS = new Set(["agentName", "caseId"]);

function renderFrontmatter(meta: Record<string, string>): string {
  const lines = FRONTMATTER_ORDER.filter((k) => meta[k] !== undefined && meta[k] !== "").map((k) =>
    QUOTED_KEYS.has(k) ? `${k}: ${JSON.stringify(meta[k])}` : `${k}: ${meta[k]}`,
  );
  return `---\n${lines.join("\n")}\n---\n`;
}

interface ParsedTranscript {
  meta: Record<string, string>;
  body: string;
}

function parseTranscript(markdown: string): ParsedTranscript {
  if (!markdown.startsWith("---\n")) return { meta: {}, body: markdown };
  const end = markdown.indexOf("\n---\n", 3);
  if (end < 0) return { meta: {}, body: markdown };
  const meta: Record<string, string> = {};
  for (const line of markdown.slice(4, end).split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        value = value.replace(/^"|"$/g, "");
      }
    }
    meta[key] = value;
  }
  return { meta, body: markdown.slice(end + 5) };
}

function statusOf(meta: Record<string, string>): TranscriptStatus {
  if (meta.aborted === "true") return "aborted";
  return meta.endedAt ? "completed" : "in-flight";
}

function summaryOf(meta: Record<string, string>, fallbackAgentId: string, fallbackRunId: string): TranscriptSummary {
  return {
    runId: meta.runId || fallbackRunId,
    agentId: meta.agentId || fallbackAgentId,
    status: statusOf(meta),
    ...(meta.agentName ? { agentName: meta.agentName } : {}),
    ...(meta.startedAt ? { startedAt: meta.startedAt } : {}),
    ...(meta.endedAt ? { endedAt: meta.endedAt } : {}),
    ...(meta.caseId ? { caseId: meta.caseId } : {}),
    ...(meta.parentRunId ? { parentRunId: meta.parentRunId } : {}),
  };
}

// ── The writer ──────────────────────────────────────────────────────────────

export interface TranscriptOpenOptions {
  agentName?: string;
  kind?: TranscriptKind;
  parentRunId?: string;
  caseId?: string;
}

/**
 * One run's transcript. Construct it, `open()` it at run start, feed it the
 * run's events, `finalize()` it in the run's `finally` — that is the whole
 * contract, and every method is safe to call on a disabled or broken writer.
 */
export class TranscriptionWriter {
  private active = false;
  private file = "";
  private jsonFile = "";
  private startedAtMs = 0;
  private meta: Record<string, string> = {};
  /** callId bookkeeping for the structured entries: a generator for callers
   *  that have no id of their own (the CLI runners), and the last unmatched
   *  call per tool name so a result without an explicit id pairs to it. */
  private callSeq = 0;
  private lastCallIdByName = new Map<string, string>();
  /** Serializes appends. The runners feed this writer from a SYNCHRONOUS emit
   *  handler and must not await it (that would put file I/O on the agent
   *  loop's critical path), so every write is chained onto the previous one
   *  here — otherwise concurrent `appendFile` calls could land out of order. */
  private tail: Promise<void> = Promise.resolve();

  /** True when this writer is actually recording (config on and I/O healthy). */
  get enabled(): boolean {
    return this.active;
  }

  /** Where this run's transcript lives (empty when disabled). */
  get filePath(): string {
    return this.file;
  }

  async open(agentId: string, runId: string, taskInput: string, opts?: TranscriptOpenOptions): Promise<void> {
    if (!(await transcriptEnabled())) return;
    const startedAt = new Date();
    this.startedAtMs = startedAt.getTime();
    this.file = transcriptPathFor(agentId, runId);
    this.jsonFile = transcriptJsonPathFor(agentId, runId);
    this.meta = {
      agentId,
      runId,
      startedAt: startedAt.toISOString(),
      kind: opts?.kind ?? "local",
      ...(opts?.agentName ? { agentName: opts.agentName } : {}),
      ...(opts?.parentRunId ? { parentRunId: opts.parentRunId } : {}),
      ...(opts?.caseId ? { caseId: opts.caseId } : {}),
    };
    const header =
      renderFrontmatter(this.meta) +
      `\n# ${opts?.agentName || agentId} — run ${runId}\n\n## Task\n${truncate(taskInput, MAX_TASK)}\n\n## Timeline\n`;
    this.active = true;
    const opening: TranscriptEntry = { type: "task_input", text: clip(taskInput ?? "", MAX_JSON_FIELD) };
    await this.enqueue(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await writeFileAtomic(this.file, header);
      await writeFileAtomic(this.jsonFile, `${JSON.stringify(opening)}\n`);
    });
  }

  appendAssistantText(text: string): Promise<void> {
    if (!text?.trim()) return Promise.resolve();
    return this.record(`**assistant** ${truncate(text, MAX_TEXT)}`, { type: "assistant_text", text: clip(text, MAX_JSON_FIELD) });
  }

  /** Only emitted when the provider actually supplies reasoning (FR-029's
   *  "including provider reasoning where available"). */
  appendReasoning(text: string): Promise<void> {
    if (!text?.trim()) return Promise.resolve();
    return this.record(`**reasoning** ${truncate(text, MAX_TEXT)}`, { type: "reasoning", text: clip(text, MAX_JSON_FIELD) });
  }

  appendToolCall(name: string, input: unknown, callId?: string): Promise<void> {
    const id = callId?.trim() || `call-${++this.callSeq}`;
    this.lastCallIdByName.set(name, id);
    return this.record(`\`${name}\`(${compactInput(input)})`, {
      type: "tool_call",
      callId: id,
      name,
      args: jsonArgs(input),
      status: "running",
    });
  }

  /** `ok`/`error:` reuses the loop's own in-band `Error: …` convention rather
   *  than re-deriving success from the result text. */
  appendToolResult(name: string, result: string, ok: boolean, callId?: string): Promise<void> {
    const id = callId?.trim() || this.lastCallIdByName.get(name) || `call-${++this.callSeq}`;
    this.lastCallIdByName.delete(name);
    return this.record(`  ↳ ${name} → ${ok ? "ok" : "error"}: ${truncate(result, MAX_RESULT)}`, {
      type: "tool_result",
      callId: id,
      name,
      status: ok ? "ok" : "error",
      result: clip(result ?? "", MAX_JSON_FIELD),
    });
  }

  /**
   * Close the run out: append the end marker and stamp `endedAt` (plus
   * `aborted: true` on a kill) into the frontmatter, so a reader can tell an
   * in-flight run from a finished one and a finished one from a stopped one.
   *
   * The frontmatter is re-read from disk first, so a `caseId` another writer
   * stamped in the meantime (ADR-10's consumer stamp) survives.
   */
  async finalize(opts?: { endedAt?: number; aborted?: boolean }): Promise<void> {
    if (!this.active) return;
    const endedAt = new Date(opts?.endedAt ?? Date.now());
    const aborted = opts?.aborted === true;
    await this.line(aborted ? "**assistant (aborted)** — run stopped" : "**run ended** — completed");
    await this.enqueue(async () => {
      const parsed = parseTranscript(await fs.readFile(this.file, "utf8"));
      const meta = { ...this.meta, ...parsed.meta, endedAt: endedAt.toISOString(), ...(aborted ? { aborted: "true" } : {}) };
      await writeFileAtomic(this.file, renderFrontmatter(meta) + parsed.body);
    });
    this.active = false;
  }

  /** Markdown-only line (finalize's end marker — run status is frontmatter,
   *  not a structured entry). */
  private line(text: string): Promise<void> {
    if (!this.active) return Promise.resolve();
    const at = stamp(Date.now() - this.startedAtMs);
    return this.enqueue(() => fs.appendFile(this.file, `- ${at} ${text}\n`, "utf8"));
  }

  /** One event = one markdown line + one structured entry, in a single queue
   *  slot so the two files can never drift out of order (FR-037's "same
   *  cadence"). The entry is stringified OUTSIDE the queue: `jsonArgs` already
   *  made it serializable, so this cannot throw, and it captures the value
   *  before any caller mutation. */
  private record(text: string, entry: TranscriptEntry): Promise<void> {
    if (!this.active) return Promise.resolve();
    const at = stamp(Date.now() - this.startedAtMs);
    const jsonLine = `${JSON.stringify(entry)}\n`;
    return this.enqueue(async () => {
      await fs.appendFile(this.file, `- ${at} ${text}\n`, "utf8");
      await fs.appendFile(this.jsonFile, jsonLine, "utf8");
    });
  }

  /** Chain one write after the last, and swallow its failure.
   *
   *  A transcript must never be able to fail a run, so the first I/O error
   *  disables this writer (a broken path must not log once per event) and is
   *  reported at warn level exactly once. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.tail.then(async () => {
      try {
        await fn();
      } catch (e) {
        this.active = false;
        logger().warn(COMPONENT, `transcription disabled for ${this.meta.runId}: ${e}`, {});
      }
    });
    this.tail = next;
    return next;
  }
}

// ── Readers (the read-only API's implementation) ────────────────────────────

/** Locate a run's transcript across the per-agent directories. The runId
 *  embeds its agent id, but a directory walk is both simpler and correct for
 *  every generator, and the tree is one level deep. */
async function findTranscriptFile(runId: string): Promise<{ file: string; agentId: string } | undefined> {
  const root = transcriptsDir();
  const wanted = `${segment(runId)}.md`;
  const agents = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of agents) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, wanted);
    if (await fs.stat(file).then(() => true).catch(() => false)) return { file, agentId: entry.name };
  }
  return undefined;
}

/** One run's transcript, verbatim, with its status derived from the
 *  frontmatter. `undefined` when the run has no transcript (never transcribed,
 *  or transcriptions were disabled). */
export async function readTranscript(runId: string): Promise<TranscriptDocument | undefined> {
  const found = await findTranscriptFile(runId);
  if (!found) return undefined;
  const markdown = await fs.readFile(found.file, "utf8").catch(() => undefined);
  if (markdown === undefined) return undefined;
  const { meta } = parseTranscript(markdown);
  return { ...summaryOf(meta, found.agentId, runId), markdown };
}

/**
 * One run's structured entries (FR-037), in write order. `undefined` when the
 * run has no `.ndjson` — either never transcribed at all, or transcribed
 * before the companion existed — which the API answers with the markdown
 * instead. A torn tail line (crash mid-append) is skipped, never fatal.
 */
export async function readTranscriptEntries(runId: string): Promise<TranscriptEntry[] | undefined> {
  const found = await findTranscriptFile(runId);
  if (!found) return undefined;
  const raw = await fs.readFile(found.file.replace(/\.md$/, ".ndjson"), "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      entries.push(JSON.parse(s) as TranscriptEntry);
    } catch {
      // torn line — skip
    }
  }
  return entries;
}

/** Every recorded run for one agent, newest first. */
export async function listAgentTranscripts(agentId: string): Promise<TranscriptSummary[]> {
  const dir = path.join(transcriptsDir(), segment(agentId));
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: TranscriptSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const markdown = await fs.readFile(path.join(dir, name), "utf8").catch(() => "");
    const { meta } = parseTranscript(markdown);
    out.push(summaryOf(meta, agentId, name.replace(/\.md$/, "")));
  }
  // Newest first, with the runId as a tiebreaker: two runs of the same agent
  // started inside one millisecond must still have a stable order.
  return out.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "") || b.runId.localeCompare(a.runId));
}

/**
 * Stamp the owning consumer's case id onto a run's frontmatter (ADR-10).
 *
 * The platform writer does not know what a self-heal case is, so it never
 * writes `caseId`; the consumer that LAUNCHED the run calls this once, on
 * `run_started`, which keeps the file self-describing without teaching the run
 * layer about cases. Idempotent, and `false` when there is no transcript.
 */
export async function markTranscriptCaseId(runId: string, caseId: string): Promise<boolean> {
  const found = await findTranscriptFile(runId);
  if (!found) return false;
  try {
    const parsed = parseTranscript(await fs.readFile(found.file, "utf8"));
    if (parsed.meta.caseId === caseId) return true;
    await writeFileAtomic(found.file, renderFrontmatter({ ...parsed.meta, caseId }) + parsed.body);
    return true;
  } catch (e) {
    logger().warn(COMPONENT, `stamping caseId on ${runId} failed: ${e}`, {});
    return false;
  }
}
