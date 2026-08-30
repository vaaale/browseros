import type { ChatMessage } from "@/lib/assistant/messages";
import type { Sidecar } from "./sidecar";
import { protectedTurnMessageIds, turnStarts } from "./turns";

// Layer 2/2b: which turns are ready to fold into a new block, and eviction of
// the oldest retained blocks once there are too many.

export interface EligibleBlock {
  /** Flattened messages belonging to this block, oldest-first. */
  messages: ChatMessage[];
}

/**
 * Find every full `blockSize`-turn group that's ready to be summarized: turns
 * before the live tail cutoff, not already grouped into an existing block, and
 * not protected (the pinned first turn, or a turn calling an unrecoverable
 * tool).
 *
 * Correctness-critical: eligible turns are chunked by POSITIONAL CONTIGUITY in
 * the original array, never by "skip protected turns and keep counting." A
 * block spanning a gap would render out of chronological order — its summary
 * would appear (at its first member's position) before a protected turn that
 * chronologically sits between two of its members, but after the last one. So
 * a protected/already-grouped turn is a hard break: eligible turns form
 * contiguous runs, and each run is chunked into blockSize groups independently
 * — a leftover partial run just waits for more turns to accumulate.
 */
export function findEligibleBlocks(
  messages: ChatMessage[],
  sidecar: Sidecar,
  tailCutIndex: number,
  unrecoverableTools: string[],
  blockSize: number,
): EligibleBlock[] {
  const starts = turnStarts(messages);
  const protectedIds = protectedTurnMessageIds(messages, unrecoverableTools);

  const turnRanges: { from: number; to: number }[] = [];
  for (let t = 0; t < starts.length; t++) {
    const from = starts[t];
    if (from >= tailCutIndex) break; // turns are ordered — everything after is the live tail
    const to = t + 1 < starts.length ? starts[t + 1] : messages.length;
    turnRanges.push({ from, to });
  }

  const isEligible = (range: { from: number; to: number }): boolean => {
    for (let i = range.from; i < range.to; i++) {
      const m = messages[i];
      if (protectedIds.has(m.id)) return false;
      if (sidecar.projections[m.id]) return false;
    }
    return true;
  };

  const runs: { from: number; to: number }[][] = [];
  let current: { from: number; to: number }[] = [];
  for (const range of turnRanges) {
    if (isEligible(range)) {
      current.push(range);
    } else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);

  const blocks: EligibleBlock[] = [];
  for (const run of runs) {
    for (let i = 0; i + blockSize <= run.length; i += blockSize) {
      const group = run.slice(i, i + blockSize);
      const from = group[0].from;
      const to = group[group.length - 1].to;
      blocks.push({ messages: messages.slice(from, to) });
    }
  }
  return blocks;
}

/** Evict the oldest retained blocks until `blockOrder.length <= maxRetainedBlocks`.
 *  Full cleanup: the block record AND every one of its member projections are
 *  removed, so those messages leave zero trace in future renders. Pure. */
export function evictOldestBlocks(sidecar: Sidecar, maxRetainedBlocks: number): Sidecar {
  if (sidecar.blockOrder.length <= maxRetainedBlocks) return sidecar;
  const blockOrder = [...sidecar.blockOrder];
  const blocks = { ...sidecar.blocks };
  const projections = { ...sidecar.projections };
  while (blockOrder.length > maxRetainedBlocks) {
    const evictId = blockOrder.shift();
    if (!evictId) break;
    const block = blocks[evictId];
    delete blocks[evictId];
    if (block) for (const id of block.memberIds) delete projections[id];
  }
  return { ...sidecar, blocks, blockOrder, projections };
}
