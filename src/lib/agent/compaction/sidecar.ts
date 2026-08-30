import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import { looksLikeInjection } from "@/lib/agent/memory/injection";
import { logger } from "@/lib/logging";

// Per-conversation compaction state (block-based redesign). The client-owned
// transcript at /Documents/Chats/<id>.json is never touched by this module —
// this is a derived cache only, safe to discard and regenerate at any time.
//
// Keyed by stable ChatMessage id instead of array position or content hash:
// ChatMessage.content/.toolCalls are never mutated in place once persisted
// (src/lib/assistant/messages.ts's truncateForEdit only ever removes the
// newest turn and everything after it), so a projection referencing an id is
// either still valid or the message is simply gone — no staleness/hash check
// needed at all.

const COMPONENT = "compaction";
const DIR = path.join(dataDir(), "memory", "compaction");
const DEFAULT_STALENESS_MS = 600_000;
const SIDECAR_VERSION = 2;

export interface Block {
  id: string;
  summary: string;
  /** ChatMessage ids belonging to this block, oldest-first. */
  memberIds: string[];
  turnCount: number;
  createdAt: string;
}

/** A message folded into a block summary. Layer 1's tool-result placeholders
 *  are NOT persisted here — they're recomputed fresh on every render (see
 *  render.ts) so a placeholder decision can never clobber a `grouped` one. */
export interface Projection {
  blockId: string;
}

export interface SidecarLock {
  acquiredAt: string;
  owner: string;
}

export interface SidecarStats {
  estimatedTokens: number;
  compactedAt: string;
  runs: number;
}

export interface Sidecar {
  version: 2;
  /** Sparse — absent id means "not grouped" (Layer 1 / verbatim). */
  projections: Record<string, Projection>;
  blocks: Record<string, Block>;
  /** Oldest-first — drives eviction order. */
  blockOrder: string[];
  lock: SidecarLock | null;
  updatedAt: string;
  stats: SidecarStats;
}

export function emptySidecar(): Sidecar {
  return {
    version: SIDECAR_VERSION,
    projections: {},
    blocks: {},
    blockOrder: [],
    lock: null,
    updatedAt: new Date(0).toISOString(),
    stats: { estimatedTokens: 0, compactedAt: new Date(0).toISOString(), runs: 0 },
  };
}

function sidecarPath(convId: string): string {
  return path.join(DIR, `${convId}.json`);
}

/** Read the sidecar for a conversation. Returns null when the file does not
 *  exist OR carries a pre-redesign (v1) shape — safe because the sidecar is a
 *  pure cache; a stale/incompatible one is simply treated as absent and
 *  regenerated fresh on next use. */
export async function readSidecar(convId: string): Promise<Sidecar | null> {
  try {
    const raw = await fs.readFile(sidecarPath(convId), "utf8");
    const parsed = JSON.parse(raw) as Partial<Sidecar>;
    if (parsed.version !== SIDECAR_VERSION) return null;
    return {
      version: SIDECAR_VERSION,
      projections: parsed.projections && typeof parsed.projections === "object" ? parsed.projections : {},
      blocks: parsed.blocks && typeof parsed.blocks === "object" ? parsed.blocks : {},
      blockOrder: Array.isArray(parsed.blockOrder) ? parsed.blockOrder : [],
      lock: parsed.lock ?? null,
      updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
      stats: parsed.stats ?? { estimatedTokens: 0, compactedAt: new Date(0).toISOString(), runs: 0 },
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Atomically persist the sidecar (temp-file + rename). */
export async function writeSidecar(convId: string, sidecar: Sidecar): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  await writeFileAtomic(sidecarPath(convId), JSON.stringify({ ...sidecar, updatedAt: new Date().toISOString() }, null, 2));
}

export async function deleteSidecar(convId: string): Promise<void> {
  try {
    await fs.unlink(sidecarPath(convId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Acquire the sidecar's block-formation lock. Returns the sidecar with the
 *  lock taken, or null when a fresh (non-stale) lock is already held. Stale
 *  locks are expired and reclaimed. */
export async function acquireLock(
  convId: string,
  opts: { stalenessMs?: number } = {},
): Promise<Sidecar | null> {
  const stalenessMs = opts.stalenessMs ?? DEFAULT_STALENESS_MS;
  const current = (await readSidecar(convId)) ?? emptySidecar();
  if (current.lock) {
    const acquiredAt = Date.parse(current.lock.acquiredAt);
    const age = Number.isFinite(acquiredAt) ? Date.now() - acquiredAt : Infinity;
    if (age < stalenessMs) return null;
    logger().warn(COMPONENT, "lock.expired", {
      conversation: convId,
      previousOwner: current.lock.owner,
      ageMs: age,
    });
  }
  const next: Sidecar = {
    ...current,
    lock: { acquiredAt: new Date().toISOString(), owner: `${process.pid}:${randomUUID()}` },
  };
  await writeSidecar(convId, next);
  return next;
}

export async function releaseLock(convId: string): Promise<void> {
  const current = await readSidecar(convId);
  if (!current || !current.lock) return;
  await writeSidecar(convId, { ...current, lock: null });
}

/** True when the candidate summary is safe to persist. Summary text re-enters
 *  prompts on later turns, so refuse obvious injection patterns. */
export function validateSummary(text: string): boolean {
  if (!text || !text.trim()) return false;
  return !looksLikeInjection(text);
}
