import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { writeFileAtomic } from "@/os/atomic-write";
import { dataDir } from "@/os/data-dir";
import { typeMatches } from "./types";
import type { EventRecord, EventState, EventSummaryView, HandlerRegistration, HandlerPreference } from "./types";

// Persistence layer for the event kernel (034-event-notification-system,
// design.md §3.4 / ADR-4). Layout under root (default dataDir()/events/):
//
//   index.json          — warm-in-memory projection, flushed on checkpoint only
//   events/<YYYY-MM>.jsonl  — immutable event bodies, append-only (O(1) per emit)
//   state/<YYYY-MM>.json    — mutable per-event state for that month
//   handlers.json       — handler registry (written immediately — rare admin op)
//   preferences.json    — default-UI-handler preferences (written immediately)
//
// Deliberate simplification vs. the literal design doc: EventState for EVERY
// event (not just the current month) is held warm in memory alongside the
// index, not lazily loaded per month. At the 100k-event target scale this is
// a few tens of MB and makes get()/history/dispatch logic synchronous and
// simple; only event BODIES (which can be up to 1MB each) stay on disk and
// are read on demand via a byte-offset seek into their month's shard — an
// O(1) read, mirroring the O(1) append on the write side.

interface IndexEntry extends EventSummaryView {
  /** Which month shard/state file this event lives in. */
  month: string;
  /** Byte offset of this event's JSON line within events/<month>.jsonl. */
  bodyOffset: number;
  /** Length in bytes of the JSON line (excluding the trailing newline). */
  bodyLength: number;
}

interface StoreShape {
  root: string;
  loaded: boolean;
  index: Map<string, IndexEntry>;
  sequences: Map<string, number>;
  states: Map<string, EventState>;
  handlers: Map<string, HandlerRegistration>;
  preferences: Map<string, HandlerPreference>;
  dirtyEventIds: Set<string>;
  indexDirty: boolean;
  changesSinceCheckpoint: number;
  checkpointTimer: NodeJS.Timeout | null;
}

// globalThis singleton — hot-reload-safe, same pattern as serviceManager()/
// serviceRegistry() (Next dev/Turbopack compiles route handlers and
// instrumentation.ts into separate module graphs; without this each would
// get its own store).
const g = globalThis as unknown as { __bosEventStore?: StoreShape };

function freshState(root: string): StoreShape {
  return {
    root,
    loaded: false,
    index: new Map(),
    sequences: new Map(),
    states: new Map(),
    handlers: new Map(),
    preferences: new Map(),
    dirtyEventIds: new Set(),
    indexDirty: false,
    changesSinceCheckpoint: 0,
    checkpointTimer: null,
  };
}

function state(): StoreShape {
  if (!g.__bosEventStore) g.__bosEventStore = freshState(path.join(dataDir(), "events"));
  return g.__bosEventStore;
}

// Checkpoint cadence (R3): whichever comes first, outside the emit mutex.
const CHECKPOINT_INTERVAL_MS = 30_000;
const CHECKPOINT_CHANGE_THRESHOLD = 500;

function monthOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function shardPath(root: string, month: string): string {
  return path.join(root, "events", `${month}.jsonl`);
}
function statePath(root: string, month: string): string {
  return path.join(root, "state", `${month}.json`);
}
function indexPath(root: string): string {
  return path.join(root, "index.json");
}
function handlersPath(root: string): string {
  return path.join(root, "handlers.json");
}
function preferencesPath(root: string): string {
  return path.join(root, "preferences.json");
}

function stopCheckpointTimer(): void {
  const s = g.__bosEventStore;
  if (s?.checkpointTimer) {
    clearInterval(s.checkpointTimer);
    s.checkpointTimer = null;
  }
}

/** Test/boot seam — points the store at a different root and forgets all
 *  in-memory state (R9: unit tests use an isolated temp root). */
export function setStoreRoot(root: string): void {
  stopCheckpointTimer();
  g.__bosEventStore = freshState(root);
}

export function getStoreRoot(): string {
  return state().root;
}

export function isStoreLoaded(): boolean {
  return state().loaded;
}

// ── Boot: load or rebuild (R8/ADR-4) ────────────────────────────────────────

export async function initStore(): Promise<void> {
  const s = state();
  if (s.loaded) return;
  await fs.mkdir(path.join(s.root, "events"), { recursive: true });
  await fs.mkdir(path.join(s.root, "state"), { recursive: true });

  await loadHandlers(s);
  await loadPreferences(s);

  const loadedFromIndex = await tryLoadIndex(s);
  if (!loadedFromIndex) await rebuildFromShards(s);
  await loadAllStateFiles(s);

  s.loaded = true;
  s.checkpointTimer = setInterval(() => void checkpoint(), CHECKPOINT_INTERVAL_MS);
  s.checkpointTimer.unref?.();
}

async function loadHandlers(s: StoreShape): Promise<void> {
  try {
    const raw = await fs.readFile(handlersPath(s.root), "utf8");
    const arr = JSON.parse(raw) as HandlerRegistration[];
    for (const h of arr) s.handlers.set(h.handlerId, h);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

async function loadPreferences(s: StoreShape): Promise<void> {
  try {
    const raw = await fs.readFile(preferencesPath(s.root), "utf8");
    const arr = JSON.parse(raw) as HandlerPreference[];
    for (const p of arr) s.preferences.set(p.eventType, p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

async function tryLoadIndex(s: StoreShape): Promise<boolean> {
  try {
    const raw = await fs.readFile(indexPath(s.root), "utf8");
    const parsed = JSON.parse(raw) as { entries: IndexEntry[]; sequences: Record<string, number> };
    for (const e of parsed.entries) s.index.set(e.id, e);
    for (const [type, seq] of Object.entries(parsed.sequences ?? {})) s.sequences.set(type, seq);
    return true;
  } catch {
    // Missing or corrupt — repair from shards (bodies are the source of truth).
    return false;
  }
}

/** Boot repair: scan every shard to reconstruct the index when index.json is
 *  missing or unreadable. Runs once at boot, off the viewer-latency path. */
async function rebuildFromShards(s: StoreShape): Promise<void> {
  s.index.clear();
  s.sequences.clear();
  const dir = path.join(s.root, "events");
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  for (const file of files.filter((f) => f.endsWith(".jsonl")).sort()) {
    const month = file.slice(0, -".jsonl".length);
    const raw = await fs.readFile(path.join(dir, file), "utf8");
    let offset = 0;
    for (const line of raw.split("\n")) {
      if (line.length === 0) {
        offset += 1;
        continue;
      }
      const lineLength = Buffer.byteLength(line, "utf8");
      try {
        const record = JSON.parse(line) as EventRecord;
        s.index.set(record.id, {
          id: record.id,
          type: record.type,
          sequence: record.sequence,
          ts: record.ts,
          source: record.source,
          summary: record.summary,
          processing: "processed",
          read: "unread",
          handlersTotal: 0,
          handlersDone: 0,
          month,
          bodyOffset: offset,
          bodyLength: lineLength,
        });
        const prevSeq = s.sequences.get(record.type) ?? 0;
        if (record.sequence > prevSeq) s.sequences.set(record.type, record.sequence);
      } catch {
        // Skip a corrupt line rather than fail boot entirely.
      }
      offset += lineLength + 1; // + newline
    }
  }
}

async function loadAllStateFiles(s: StoreShape): Promise<void> {
  const dir = path.join(s.root, "state");
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    const raw = await fs.readFile(path.join(dir, file), "utf8").catch(() => "");
    if (!raw) continue;
    try {
      const map = JSON.parse(raw) as Record<string, EventState>;
      for (const [id, st] of Object.entries(map)) {
        s.states.set(id, st);
        applyStateToIndex(s, id, st);
      }
    } catch {
      // Skip a corrupt month state file.
    }
  }
  // An indexed event with no recovered state (rebuilt-from-shards event whose
  // state file didn't survive) gets a safe default rather than staying stuck.
  for (const id of s.index.keys()) {
    if (s.states.has(id)) continue;
    const fallback: EventState = {
      eventId: id,
      processing: "processed",
      processedReason: "no-active-handlers",
      read: "unread",
      history: [],
      perHandler: {},
    };
    s.states.set(id, fallback);
    applyStateToIndex(s, id, fallback);
  }
}

function applyStateToIndex(s: StoreShape, id: string, st: EventState): void {
  const entry = s.index.get(id);
  if (!entry) return;
  entry.processing = st.processing;
  entry.processedReason = st.processedReason;
  entry.read = st.read;
  entry.handlersTotal = Object.keys(st.perHandler).length;
  entry.handlersDone = Object.values(st.perHandler).filter((h) => h.status !== "pending").length;
}

// ── Write mutex (per-process, matches notifications/store.ts) ──────────────

let lock: Promise<void> = Promise.resolve();
async function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = lock;
  let release!: () => void;
  const next = new Promise<void>((res) => (release = res));
  lock = prev.then(() => next);
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

function markDirty(s: StoreShape, eventId: string): void {
  s.dirtyEventIds.add(eventId);
  s.indexDirty = true;
  s.changesSinceCheckpoint += 1;
  if (s.changesSinceCheckpoint >= CHECKPOINT_CHANGE_THRESHOLD) void checkpoint();
}

let idCounter = 0;
function nextEventId(ts: number): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `evt_${ts.toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Emit critical path (NFR-001): allocate the per-type sequence, append the
 * immutable body (single O(1) shard append), and create the initial
 * in-memory index+state entries. Index/state persistence is deferred to the
 * checkpoint cadence — this function's only durable fs write is the append.
 */
export async function appendEvent(input: {
  type: string;
  payload: Record<string, unknown>;
  source: EventRecord["source"];
  summary: string;
}): Promise<EventRecord> {
  const s = state();
  return withLock(async () => {
    const ts = Date.now();
    const sequence = (s.sequences.get(input.type) ?? 0) + 1;
    s.sequences.set(input.type, sequence);
    const id = nextEventId(ts);
    const record: EventRecord = {
      id,
      type: input.type,
      payload: input.payload,
      source: input.source,
      ts,
      sequence,
      summary: input.summary,
    };
    const month = monthOf(ts);
    const line = JSON.stringify(record);
    const file = shardPath(s.root, month);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const stat = await fs.stat(file).catch(() => null);
    const offset = stat?.size ?? 0;
    await fs.appendFile(file, `${line}\n`, "utf8");

    s.index.set(id, {
      id,
      type: record.type,
      sequence,
      ts,
      source: record.source,
      summary: record.summary,
      processing: "pending",
      read: "unread",
      handlersTotal: 0,
      handlersDone: 0,
      month,
      bodyOffset: offset,
      bodyLength: Buffer.byteLength(line, "utf8"),
    });
    s.states.set(id, { eventId: id, processing: "pending", read: "unread", history: [], perHandler: {} });
    markDirty(s, id);
    return record;
  });
}

/**
 * Migration-only append (R6): writes an event body with a CALLER-SUPPLIED id
 * and timestamp, marked already-processed with no dispatch history (a
 * migrated legacy notification isn't re-run through live headless
 * handlers). Idempotent — a repeat call with an id already in the index is a
 * silent no-op, which is what makes the marker-file-guarded migration safe
 * to retry after a partial failure.
 */
export async function appendMigratedEvent(input: {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  source: EventRecord["source"];
  summary: string;
  ts: number;
  read: "unread" | "read";
}): Promise<boolean> {
  const s = state();
  return withLock(async () => {
    if (s.index.has(input.id)) return false;
    const sequence = (s.sequences.get(input.type) ?? 0) + 1;
    s.sequences.set(input.type, sequence);
    const record: EventRecord = {
      id: input.id,
      type: input.type,
      payload: input.payload,
      source: input.source,
      ts: input.ts,
      sequence,
      summary: input.summary,
    };
    const month = monthOf(input.ts);
    const line = JSON.stringify(record);
    const file = shardPath(s.root, month);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const stat = await fs.stat(file).catch(() => null);
    const offset = stat?.size ?? 0;
    await fs.appendFile(file, `${line}\n`, "utf8");

    s.index.set(input.id, {
      id: input.id,
      type: record.type,
      sequence,
      ts: input.ts,
      source: record.source,
      summary: record.summary,
      processing: "processed",
      read: input.read,
      handlersTotal: 0,
      handlersDone: 0,
      month,
      bodyOffset: offset,
      bodyLength: Buffer.byteLength(line, "utf8"),
    });
    s.states.set(input.id, {
      eventId: input.id,
      processing: "processed",
      processedReason: "no-active-handlers",
      read: input.read,
      history: [],
      perHandler: {},
    });
    markDirty(s, input.id);
    return true;
  });
}

function stripInternal(e: IndexEntry): EventSummaryView {
  return {
    id: e.id,
    type: e.type,
    sequence: e.sequence,
    ts: e.ts,
    source: e.source,
    summary: e.summary,
    processing: e.processing,
    processedReason: e.processedReason,
    read: e.read,
    handlersTotal: e.handlersTotal,
    handlersDone: e.handlersDone,
  };
}

export function getIndexEntry(id: string): EventSummaryView | undefined {
  const e = state().index.get(id);
  return e ? stripInternal(e) : undefined;
}

export function getEventState(id: string): EventState | undefined {
  return state().states.get(id);
}

/** O(1) read: seek to the recorded byte offset in the event's month shard. */
export async function getEventBody(id: string): Promise<EventRecord | undefined> {
  const s = state();
  const entry = s.index.get(id);
  if (!entry) return undefined;
  const file = shardPath(s.root, entry.month);
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(file, "r");
    const buf = Buffer.alloc(entry.bodyLength);
    await fh.read(buf, 0, entry.bodyLength, entry.bodyOffset);
    return JSON.parse(buf.toString("utf8")) as EventRecord;
  } catch {
    return undefined;
  } finally {
    await fh?.close();
  }
}

export interface QueryFilter {
  type?: string;
  status?: "pending" | "processed";
  read?: "unread" | "read";
  from?: number;
  to?: number;
  cursor?: string | null;
  limit?: number;
}

export interface QueryResult {
  events: EventSummaryView[];
  nextCursor: string | null;
  unreadTotal: number;
}

export function query(filter: QueryFilter): QueryResult {
  const s = state();
  let all = Array.from(s.index.values());
  if (filter.type) all = all.filter((e) => e.type === filter.type || e.type.startsWith(`${filter.type}.`));
  if (filter.status) all = all.filter((e) => e.processing === filter.status);
  if (filter.read) all = all.filter((e) => e.read === filter.read);
  if (filter.from != null) all = all.filter((e) => e.ts >= filter.from!);
  if (filter.to != null) all = all.filter((e) => e.ts <= filter.to!);
  all.sort((a, b) => b.ts - a.ts || b.sequence - a.sequence);

  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = filter.cursor ? Number(filter.cursor) || 0 : 0;
  const page = all.slice(offset, offset + limit);
  const nextCursor = offset + limit < all.length ? String(offset + limit) : null;

  return { events: page.map(stripInternal), nextCursor, unreadTotal: unreadCount() };
}

export function listAll(): EventSummaryView[] {
  return Array.from(state().index.values()).map(stripInternal);
}

export function listPending(): EventSummaryView[] {
  return listAll().filter((e) => e.processing === "pending");
}

export function unreadCount(): number {
  let n = 0;
  for (const e of state().index.values()) if (e.read === "unread") n++;
  return n;
}
export function pendingCount(): number {
  let n = 0;
  for (const e of state().index.values()) if (e.processing === "pending") n++;
  return n;
}
export function totalCount(): number {
  return state().index.size;
}

/** Mutate an event's mutable state (kernel/dispatch only). Recomputes the
 *  index projection and marks the event dirty for the next checkpoint. */
export function updateEventState(id: string, mutate: (st: EventState) => void): EventState | undefined {
  const s = state();
  const st = s.states.get(id);
  if (!st) return undefined;
  mutate(st);
  applyStateToIndex(s, id, st);
  markDirty(s, id);
  return st;
}

// ── Handler registry ─────────────────────────────────────────────────────

export function getHandler(handlerId: string): HandlerRegistration | undefined {
  return state().handlers.get(handlerId);
}
export function listHandlers(): HandlerRegistration[] {
  return Array.from(state().handlers.values());
}
export function listHandlersForType(eventType: string): HandlerRegistration[] {
  return listHandlers().filter((h) => typeMatches(h.eventType, eventType));
}
export async function putHandler(reg: HandlerRegistration): Promise<void> {
  const s = state();
  s.handlers.set(reg.handlerId, reg);
  await flushHandlers(s);
}
export async function removeHandler(handlerId: string): Promise<HandlerRegistration | undefined> {
  const s = state();
  const existing = s.handlers.get(handlerId);
  if (existing) {
    s.handlers.delete(handlerId);
    await flushHandlers(s);
  }
  return existing;
}
async function flushHandlers(s: StoreShape): Promise<void> {
  await writeFileAtomic(handlersPath(s.root), JSON.stringify(Array.from(s.handlers.values()), null, 2));
}

// ── Preferences ──────────────────────────────────────────────────────────

export function getPreference(eventType: string): HandlerPreference | undefined {
  return state().preferences.get(eventType);
}
export function listPreferences(): HandlerPreference[] {
  return Array.from(state().preferences.values());
}
export async function setPreference(eventType: string, preferredHandlerId: string | null): Promise<void> {
  const s = state();
  if (preferredHandlerId) s.preferences.set(eventType, { eventType, preferredHandlerId, ts: Date.now() });
  else s.preferences.delete(eventType);
  await flushPreferences(s);
}
async function flushPreferences(s: StoreShape): Promise<void> {
  await writeFileAtomic(preferencesPath(s.root), JSON.stringify(Array.from(s.preferences.values()), null, 2));
}

// ── Checkpoint (R3): outside the emit mutex, dual cadence ──────────────────

let checkpointRunning: Promise<void> | null = null;

export async function checkpoint(): Promise<void> {
  if (checkpointRunning) return checkpointRunning;
  checkpointRunning = doCheckpoint().finally(() => {
    checkpointRunning = null;
  });
  return checkpointRunning;
}

async function doCheckpoint(): Promise<void> {
  const s = state();
  if (!s.loaded) return;
  if (!s.indexDirty && s.dirtyEventIds.size === 0) return;

  const dirtyIds = Array.from(s.dirtyEventIds);
  s.dirtyEventIds.clear();
  s.indexDirty = false;
  s.changesSinceCheckpoint = 0;

  const dirtyMonths = new Set<string>();
  for (const id of dirtyIds) {
    const entry = s.index.get(id);
    if (entry) dirtyMonths.add(entry.month);
  }

  for (const month of dirtyMonths) {
    const monthMap: Record<string, EventState> = {};
    for (const [id, entry] of s.index) {
      if (entry.month !== month) continue;
      const st = s.states.get(id);
      if (st) monthMap[id] = st;
    }
    await writeFileAtomic(statePath(s.root, month), JSON.stringify(monthMap));
  }

  const payload = { entries: Array.from(s.index.values()), sequences: Object.fromEntries(s.sequences) };
  await writeFileAtomic(indexPath(s.root), JSON.stringify(payload));
}

/** Unconditional flush — call on graceful shutdown. */
export async function flushAll(): Promise<void> {
  const s = state();
  if (!s.loaded) return;
  s.indexDirty = true;
  for (const id of s.states.keys()) s.dirtyEventIds.add(id);
  await checkpoint();
}

/** Test-only: flush then stop the checkpoint timer and forget in-memory state. */
export async function shutdownStore(): Promise<void> {
  await flushAll();
  stopCheckpointTimer();
}

export function currentMonthKey(): string {
  return monthOf(Date.now());
}

/** Count failed/permanently_failed acks for a handler within a given month —
 *  backs the configuration page's per-handler "recent failures" badge. */
export function countHandlerFailuresInMonth(handlerId: string, month: string): number {
  const s = state();
  let n = 0;
  for (const [id, entry] of s.index) {
    if (entry.month !== month) continue;
    const st = s.states.get(id);
    if (!st) continue;
    for (const h of st.history) {
      if (h.handlerId === handlerId && (h.status === "failed" || h.status === "permanently_failed")) n++;
    }
  }
  return n;
}

/**
 * Perf-test seam (NFR-002/NFR-003, T052): seed the warm index + state maps
 * directly, without disk I/O, so query()/count() latency can be measured at
 * the 100k-event floor without waiting on 100k real fs writes. Seeded
 * entries have no real shard line — getEventBody() will not find them; only
 * index/state-based ops (query, count) are meaningful after seeding.
 */
export function _seedIndexForTests(n: number): void {
  const s = state();
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const id = `seed-${i}`;
    const type = `com.bos.perf.type${i % 20}`;
    const read: "unread" | "read" = i % 3 === 0 ? "unread" : "read";
    s.index.set(id, {
      id,
      type,
      sequence: i,
      ts: now - i,
      source: { appId: "perf", name: "Perf" },
      summary: `seed event ${i}`,
      processing: "processed",
      processedReason: "no-active-handlers",
      read,
      handlersTotal: 0,
      handlersDone: 0,
      month: "2026-01",
      bodyOffset: 0,
      bodyLength: 0,
    });
    s.states.set(id, {
      eventId: id,
      processing: "processed",
      processedReason: "no-active-handlers",
      read,
      history: [],
      perHandler: {},
    });
  }
}
