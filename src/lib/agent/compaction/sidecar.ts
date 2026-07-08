import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import { looksLikeInjection } from "@/lib/agent/memory/injection";
import { logger } from "@/lib/logging";
import type { CompactionPrompt } from "./estimate";
import { canonicalizePromptMessages, hashCanonical } from "./canonical";

// Per-conversation compaction state (spec 022 FR-010). The client-owned
// transcript at /Documents/Chats/<id>.json is never touched by this module.

const COMPONENT = "compaction";
const DIR = path.join(dataDir(), "memory", "compaction");
const DEFAULT_STALENESS_MS = 600_000;

export interface SidecarBoundary {
  /** Number of client messages covered by the summary. */
  count: number;
  /** SHA-256 hex of the JSON-serialized span up to boundary.count. */
  spanHash: string;
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
  boundary: SidecarBoundary | null;
  summary: string | null;
  clearWatermark: number;
  lock: SidecarLock | null;
  updatedAt: string;
  stats: SidecarStats;
}

export function emptySidecar(): Sidecar {
  return {
    boundary: null,
    summary: null,
    clearWatermark: 0,
    lock: null,
    updatedAt: new Date(0).toISOString(),
    stats: { estimatedTokens: 0, compactedAt: new Date(0).toISOString(), runs: 0 },
  };
}

function sidecarPath(convId: string): string {
  return path.join(DIR, `${convId}.json`);
}

/** Read the sidecar for a conversation. Returns null when the file does not exist. */
export async function readSidecar(convId: string): Promise<Sidecar | null> {
  try {
    const raw = await fs.readFile(sidecarPath(convId), "utf8");
    const parsed = JSON.parse(raw) as Partial<Sidecar>;
    // Fill defaults defensively so an older sidecar shape still opens cleanly.
    return {
      boundary: parsed.boundary ?? null,
      summary: parsed.summary ?? null,
      clearWatermark: typeof parsed.clearWatermark === "number" ? parsed.clearWatermark : 0,
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

/** Stable content hash of the summarized span. Uses the shape-independent
 *  canonical form (see canonical.ts) so a hash computed on the client-side
 *  transcript matches the hash computed on the v3 prompt for equivalent
 *  content. */
export function computeSpanHash(messages: CompactionPrompt): string {
  return hashCanonical(canonicalizePromptMessages(messages));
}

/** Acquire the sidecar's summarization lock. Returns the sidecar with the lock
 *  taken, or null when a fresh (non-stale) lock is already held. Stale locks
 *  are expired and reclaimed. */
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

/** True when the candidate summary is safe to persist. FR-010: summary text
 *  re-enters prompts on the next turn, so refuse obvious injection patterns. */
export function validateSummary(text: string): boolean {
  if (!text || !text.trim()) return false;
  return !looksLikeInjection(text);
}
