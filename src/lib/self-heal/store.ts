import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import {
  emptyIndex,
  isTerminalStatus,
  type CaseRun,
  type CaseRunStatus,
  type CaseStatus,
  type CostLedgerEntry,
  type DedupeEntry,
  type FailureSignature,
  type HealingCase,
  type SelfHealIndex,
  type StuckSignature,
  type TriggerContext,
  type TriggerType,
} from "./types";

// The Healing Case store (031-self-healing FR-018, design ADR-6).
//
// This is the SINGLE SOURCE OF TRUTH for mutable self-heal state. 034 events
// are the derived audit/notification channel and never hold the state machine.
//
// Layout (runtime, gitignored, created on first write):
//   data/self-heal/index.json        — warm index: dedupe map, cost ledger,
//                                      in-flight slot, both bounded queues
//   data/self-heal/cases/<id>.json   — the full record + timeline
//
// Writes go through `@/os/atomic-write` (temp file + fsync + rename), the same
// discipline the config and conflict-session stores use, so the hardlink data
// clone backend stays safe and a crash never leaves a half-written index.
//
// Every mutation is serialized through ONE in-process promise chain
// (`withIndex`). The durable file is the authority across processes (the
// Supervisor keeps BASE + PREVIEW alive); the chain removes the read-modify-
// write race inside a process, which is where all the real concurrency is (the
// event handler, the API route and the tools all run here).

function rootDir(): string {
  // Resolved per call, never captured at module scope: dataDir() is env-driven
  // and a preview's data clone points it somewhere else.
  return path.join(dataDir(), "self-heal");
}

function indexPath(): string {
  return path.join(rootDir(), "index.json");
}

function casePath(id: string): string {
  return path.join(rootDir(), "cases", `${id}.json`);
}

// ── Serialization ───────────────────────────────────────────────────────────

const GLOBAL_KEY = "__bosSelfHealStore" as const;

interface StoreState {
  chain: Promise<unknown>;
}

function state(): StoreState {
  const g = globalThis as unknown as Record<string, StoreState | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { chain: Promise.resolve() };
  return g[GLOBAL_KEY]!;
}

/** Run `fn` as the next link in the store's single critical section. */
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const s = state();
  const next = s.chain.then(fn, fn);
  // Keep the chain alive on rejection so one failed mutation can't wedge the
  // store forever (the caller still sees the rejection).
  s.chain = next.catch(() => undefined);
  return next;
}

/** Reset the in-process chain. Tests only. */
export function _resetStoreForTests(): void {
  const g = globalThis as unknown as Record<string, StoreState | undefined>;
  g[GLOBAL_KEY] = { chain: Promise.resolve() };
}

/**
 * Await every store write queued so far. Tests only.
 *
 * The spine launches the Diagnostician and the BS pipeline FIRE-AND-FORGET (a
 * 034 core executor must settle its ack immediately — design ADR-1/R4), so a
 * test that stops observing can still have writes in flight against its temp
 * data dir. Draining the chain before tearing that directory down is what keeps
 * a passing test from failing the NEXT one with an ENOENT rename.
 */
export function _drainStoreForTests(): Promise<unknown> {
  return state().chain;
}

// ── Index ───────────────────────────────────────────────────────────────────

async function readIndexFile(): Promise<SelfHealIndex> {
  try {
    const raw = JSON.parse(await fs.readFile(indexPath(), "utf8")) as Partial<SelfHealIndex>;
    // Merge over a fresh index so a file written by an older/partial revision
    // never produces `undefined.push`.
    return { ...emptyIndex(), ...raw, version: 1 };
  } catch {
    return emptyIndex();
  }
}

async function writeIndexFile(index: SelfHealIndex): Promise<void> {
  await writeFileAtomic(indexPath(), JSON.stringify(index, null, 2));
}

/** Read the index without taking the lock (callers that only read). */
export async function readIndex(): Promise<SelfHealIndex> {
  return serialize(() => readIndexFile());
}

/**
 * Read-modify-write the index atomically. `fn` may mutate the index in place
 * and return a value; the index is persisted only if `fn` resolves.
 */
export async function withIndex<T>(fn: (index: SelfHealIndex) => Promise<T> | T): Promise<T> {
  return serialize(async () => {
    const index = await readIndexFile();
    const out = await fn(index);
    await writeIndexFile(index);
    return out;
  });
}

// ── Cases ───────────────────────────────────────────────────────────────────

async function readCaseFile(id: string): Promise<HealingCase | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(casePath(id), "utf8")) as HealingCase;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeCaseFile(record: HealingCase): Promise<void> {
  await writeFileAtomic(casePath(record.id), JSON.stringify(record, null, 2));
}

export async function getCase(id: string): Promise<HealingCase | undefined> {
  return readCaseFile(id);
}

/** Every case, newest first. The pane's list view. */
export async function listCases(): Promise<HealingCase[]> {
  const dir = path.join(rootDir(), "cases");
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const out: HealingCase[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const record = await readCaseFile(name.replace(/\.json$/, ""));
    if (record) out.push(record);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** `0001`, `0002`, … — one lowercase `[a-z0-9]+` segment, so
 *  `bos/self-heal-<id>` satisfies FEATURE_BRANCH_RE (design ADR-3). */
function formatCaseId(seq: number): string {
  return String(seq).padStart(4, "0");
}

export interface CreateCaseInput {
  trigger: TriggerType;
  title: string;
  signature: FailureSignature;
  context: TriggerContext;
  /** `queued-cost` when the daily cap was already exhausted (FR-020). */
  status?: CaseStatus;
  note?: string;
}

/**
 * Create a case, allocate its id, and register it in the index (case entry +
 * dedupe entry) in ONE critical section — so two concurrent triggers can never
 * be handed the same id or both miss each other's dedupe entry.
 */
export async function createCase(input: CreateCaseInput): Promise<HealingCase> {
  return withIndex(async (index) => {
    const id = formatCaseId(index.nextCaseSeq);
    index.nextCaseSeq += 1;
    const now = Date.now();
    const status = input.status ?? "new";
    const record: HealingCase = {
      id,
      trigger: input.trigger,
      title: input.title,
      signature: input.signature,
      context: input.context,
      status,
      createdAt: now,
      updatedAt: now,
      timeline: [{ at: now, status, note: input.note ?? `case created from ${input.trigger} trigger` }],
    };
    index.cases[id] = { status, updatedAt: now };
    index.dedupe[input.signature.dedupeKey] = { dedupeKey: input.signature.dedupeKey, caseId: id, status, at: now };
    await writeCaseFile(record);
    return record;
  });
}

export interface UpdateCaseInput extends Partial<Omit<HealingCase, "id" | "timeline" | "createdAt">> {
  /** Appended to the timeline when the status changes (or when set). */
  note?: string;
}

/**
 * Patch a case and mirror the new status into the index (case entry + dedupe
 * entry). Idempotent by construction: a redelivered event that patches the same
 * fields to the same values changes nothing but the timestamp — which is what
 * makes the spine's at-least-once event delivery safe (design ADR-1).
 *
 * Returns `undefined` when the case doesn't exist (never throws — the callers
 * are event handlers and tools that must not die on a stale id).
 */
export async function updateCase(id: string, patch: UpdateCaseInput): Promise<HealingCase | undefined> {
  return withIndex(async (index) => {
    const record = await readCaseFile(id);
    if (!record) return undefined;
    const { note, ...fields } = patch;
    const now = Date.now();
    const statusChanged = typeof fields.status === "string" && fields.status !== record.status;
    Object.assign(record, fields);
    record.updatedAt = now;
    if (statusChanged || note) {
      record.timeline.push({ at: now, status: record.status, ...(note ? { note } : {}) });
    }
    index.cases[id] = { status: record.status, updatedAt: now };
    const dedupe = index.dedupe[record.signature.dedupeKey];
    if (dedupe && dedupe.caseId === id) dedupe.status = record.status;
    // The slow-path slot is released on ANY terminal state, in the same
    // transaction as the status write, so it can never leak (design ADR-9).
    if (index.inFlightSlowPathCaseId === id && isTerminalStatus(record.status)) {
      index.inFlightSlowPathCaseId = null;
    }
    await writeCaseFile(record);
    return record;
  });
}

/** Append a timeline note without changing status (progress within a state). */
export async function appendTimeline(id: string, note: string): Promise<HealingCase | undefined> {
  return updateCase(id, { note });
}

/**
 * Delete a case outright (FR-036 Discard) — the ONLY destructive operation in
 * this store. One critical section removes every trace the index holds: the
 * case entry, any dedupe entries pointing at it (a discarded case must not keep
 * suppressing the failure it was opened for), its queue entries, and the
 * slow-path slot if this case held it — then deletes the record file.
 *
 * Deliberately NOT deleted: the run transcripts. They are platform artifacts
 * owned by the run layer, not case state (scope-add ADR-10).
 *
 * Returns whether a record actually existed; a missing case is a no-op, never
 * an error (same discipline as updateCase).
 */
export async function deleteCase(id: string): Promise<boolean> {
  return withIndex(async (index) => {
    const record = await readCaseFile(id);
    delete index.cases[id];
    for (const [key, entry] of Object.entries(index.dedupe)) {
      if (entry.caseId === id) delete index.dedupe[key];
    }
    index.slowQueue = index.slowQueue.filter((e) => e.caseId !== id);
    index.costQueue = index.costQueue.filter((e) => e.caseId !== id);
    // Inline rather than via releaseInFlightSlot: a nested withIndex would
    // deadlock on the store's promise chain, and the release belongs in the
    // same atomic transaction as the removal anyway.
    if (index.inFlightSlowPathCaseId === id) index.inFlightSlowPathCaseId = null;
    await fs.rm(casePath(id), { force: true });
    return !!record;
  });
}

// ── Linked runs (FR-022f / FR-033, scope-add ADR-14) ────────────────────────
//
// The case record — not a scan of `data/agent-transcripts/` — is the authority
// for "which runs belong to this case". Runs are appended from the leading
// `run_started` event, so the case knows a run's id while it is still in flight,
// which is what makes Stop possible at all.

/** Record a run against a case. Keyed by runId, so a redelivered
 *  `run_started` updates rather than duplicates. */
export async function appendRun(caseId: string, run: CaseRun): Promise<HealingCase | undefined> {
  return withIndex(async (index) => {
    const record = await readCaseFile(caseId);
    if (!record) return undefined;
    const runs = record.runs ?? [];
    const at = runs.findIndex((r) => r.runId === run.runId);
    if (at >= 0) runs[at] = { ...runs[at], ...run };
    else runs.push(run);
    record.runs = runs;
    record.updatedAt = Date.now();
    index.cases[caseId] = { status: record.status, updatedAt: record.updatedAt };
    await writeCaseFile(record);
    return record;
  });
}

export async function updateRunStatus(
  caseId: string,
  runId: string,
  status: CaseRunStatus,
  extra?: { endedAt?: number },
): Promise<HealingCase | undefined> {
  return withIndex(async (index) => {
    const record = await readCaseFile(caseId);
    if (!record) return undefined;
    const run = (record.runs ?? []).find((r) => r.runId === runId);
    if (!run) return record;
    // First end state wins. A stopped run's own promise settles moments after
    // the Stop handler has already recorded `aborted`, and that late "failed"
    // must not overwrite what actually happened — same keyed-idempotent
    // discipline as every other write in this store.
    if (run.status !== "in-flight" && run.status !== status) return record;
    run.status = status;
    if (status !== "in-flight") run.endedAt = extra?.endedAt ?? Date.now();
    record.updatedAt = Date.now();
    index.cases[caseId] = { status: record.status, updatedAt: record.updatedAt };
    await writeCaseFile(record);
    return record;
  });
}

/** Stamp what the stuck detector found, on the case AND on the run it fired
 *  for (FR-033). Idempotent: firing is once per run, and a redelivery writes
 *  the same values. */
export async function setStuckSignature(caseId: string, signature: StuckSignature): Promise<HealingCase | undefined> {
  return withIndex(async (index) => {
    const record = await readCaseFile(caseId);
    if (!record) return undefined;
    record.stuckSignature = signature;
    const run = (record.runs ?? []).find((r) => r.runId === signature.runId);
    if (run) run.stuck = signature;
    record.updatedAt = Date.now();
    index.cases[caseId] = { status: record.status, updatedAt: record.updatedAt };
    await writeCaseFile(record);
    return record;
  });
}

export async function listCaseRuns(caseId: string): Promise<CaseRun[]> {
  return (await readCaseFile(caseId))?.runs ?? [];
}

// ── Dedupe map (FR-019) ─────────────────────────────────────────────────────

export async function getDedupeEntry(dedupeKey: string): Promise<DedupeEntry | undefined> {
  const index = await readIndex();
  return index.dedupe[dedupeKey];
}

export async function setDedupeEntry(entry: DedupeEntry): Promise<void> {
  await withIndex((index) => {
    index.dedupe[entry.dedupeKey] = entry;
  });
}

// ── The mutual-exclusion slot (FR-015c, ADR-9) ──────────────────────────────

export async function getInFlightSlowPathCaseId(): Promise<string | null> {
  return (await readIndex()).inFlightSlowPathCaseId;
}

/**
 * Claim the single slow-path slot for `caseId`. Returns true when the caller
 * now holds it (including a re-claim by the current holder, which keeps resume
 * idempotent), false when another case holds it.
 */
export async function claimInFlightSlot(caseId: string): Promise<boolean> {
  return withIndex((index) => {
    if (index.inFlightSlowPathCaseId && index.inFlightSlowPathCaseId !== caseId) return false;
    index.inFlightSlowPathCaseId = caseId;
    return true;
  });
}

export async function clearInFlightSlot(caseId?: string): Promise<void> {
  await withIndex((index) => {
    if (!caseId || index.inFlightSlowPathCaseId === caseId) index.inFlightSlowPathCaseId = null;
  });
}

/**
 * Free the slot for a case that is NOT terminal — the Stop path (FR-034,
 * ADR-13).
 *
 * `updateCase` releases the slot only on a terminal status, which is right for
 * every other transition; `stopped` is deliberately non-terminal, so Stop has
 * to say so explicitly. Named separately from `clearInFlightSlot` because the
 * intent is the interesting part: a stopped run consumes no pipeline resources,
 * and holding the single slot while the user thinks would block every other fix
 * indefinitely. `suspended` is the opposite case and still HOLDS the slot.
 */
export async function releaseInFlightSlot(caseId: string): Promise<void> {
  await clearInFlightSlot(caseId);
}

// ── Cost ledger (FR-020, ADR-5) ─────────────────────────────────────────────

export async function getCostLedger(): Promise<CostLedgerEntry[]> {
  return (await readIndex()).ledger;
}

export async function appendCostLedger(entry: CostLedgerEntry): Promise<void> {
  await withIndex((index) => {
    index.ledger.push(entry);
  });
}

/** Where the store lives — for docs, diagnostics and tests. */
export function selfHealDir(): string {
  return rootDir();
}
