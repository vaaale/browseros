import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { writeFileAtomic } from "@/os/atomic-write";
import { integrationsRoot, ensureIntegrationsRoot } from "../paths";
import type { IntegrationEvent } from "../types";

// Notification inbox: append-only JSON store of `IntegrationEvent`s emitted by
// adapters (e.g. Gmail `pollOnce` returning `new_email` events).
//
// Layout:
//   data/integrations/notifications.json
//   { "items": [ { id, event, read }, ... ], "seq": 42 }
//
// The Dock badge counter = count of items with `read === false`. Items are
// stored newest-first; the store bounds the array at MAX_ITEMS so an idle
// integration polling every few minutes doesn't grow it without limit.
//
// Serialisation: a per-process mutex serialises read-modify-write, matching
// the pattern used by the state store (../state/store.ts).

const MAX_ITEMS = 500;

export interface StoredNotification {
  /** Monotonic id assigned on insert. Also the primary sort key. */
  id: number;
  /** Original event as emitted by the adapter. */
  event: IntegrationEvent;
  /** Whether the user has viewed / dismissed this notification. */
  read: boolean;
}

interface StoredShape {
  items: StoredNotification[];
  seq: number;
}

function file(): string {
  return path.join(integrationsRoot(), "notifications.json");
}

function empty(): StoredShape {
  return { items: [], seq: 0 };
}

let lock: Promise<void> = Promise.resolve();
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
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

async function readRaw(): Promise<StoredShape> {
  try {
    const buf = await fs.readFile(file(), "utf8");
    const parsed = JSON.parse(buf) as Partial<StoredShape>;
    return {
      items: Array.isArray(parsed.items) ? parsed.items : [],
      seq: typeof parsed.seq === "number" ? parsed.seq : 0,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw err;
  }
}

async function writeRaw(next: StoredShape): Promise<void> {
  await ensureIntegrationsRoot();
  await writeFileAtomic(file(), JSON.stringify(next, null, 2));
}

/**
 * Append a new event to the inbox and bump the badge counter. Returns the
 * assigned notification id — useful for tests and for the poll route which
 * echoes the count of inserts back to the caller.
 */
export async function emitNotification(event: IntegrationEvent): Promise<number> {
  return withLock(async () => {
    const state = await readRaw();
    const id = state.seq + 1;
    const next: StoredShape = {
      seq: id,
      items: [{ id, event, read: false }, ...state.items].slice(0, MAX_ITEMS),
    };
    await writeRaw(next);
    return id;
  });
}

/**
 * Return the inbox contents (newest first). `unreadOnly` filters to unread
 * items — used by the Dock badge and the "mark inbox read" UI.
 */
export async function listNotifications(opts: { unreadOnly?: boolean } = {}): Promise<StoredNotification[]> {
  const state = await readRaw();
  return opts.unreadOnly ? state.items.filter((n) => !n.read) : state.items;
}

/** Count of unread notifications. Cheaper than listing when only the badge cares. */
export async function unreadCount(): Promise<number> {
  const state = await readRaw();
  let n = 0;
  for (const item of state.items) if (!item.read) n++;
  return n;
}

/**
 * Mark every unread notification as read. Called from the Dock badge click.
 * Returns the number of items flipped.
 */
export async function markAllRead(): Promise<number> {
  return withLock(async () => {
    const state = await readRaw();
    let flipped = 0;
    const items = state.items.map((n) => {
      if (!n.read) {
        flipped++;
        return { ...n, read: true };
      }
      return n;
    });
    if (flipped > 0) await writeRaw({ ...state, items });
    return flipped;
  });
}

/** Test-only: wipe the file. Never called from production paths. */
export async function _resetNotifications(): Promise<void> {
  await withLock(async () => {
    await writeRaw(empty());
  });
}
