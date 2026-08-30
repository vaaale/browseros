import type { ChatMessage } from "@/lib/assistant/messages";
import type { Block, Projection, Sidecar } from "./sidecar";
import { buildToolNameIndex, findKeepPairsCutIndex, protectedTurnMessageIds } from "./turns";

// Pure view transformation, native to ChatMessage[] (spec 022 FR-004..012,
// redesigned). No I/O, no clocks, no randomness. Replaces the old view.ts:
// Layer 1 (placeholder old tool results) and Layer 2 (splice in a summary) are
// now a SINGLE pass over the transcript, since both are per-message-id
// decisions with no position bookkeeping to reconcile.

export interface RenderConfig {
  keepToolResults: number;
  unrecoverableTools: string[];
}

const PLACEHOLDER_FULL = (name: string) => `<tool_result:${name}>output elided to save context — re-run the tool if the output is needed again</tool_result:${name}>`;
const PLACEHOLDER_SHORT = (name: string) => `<tool_result:${name}>elided</tool_result:${name}>`;

/** Layer 1: which tool-result messages get their content replaced, and with
 *  what text. Recomputed fresh every render — NOT persisted — so it can never
 *  clobber a `grouped` (block-membership) projection, and it naturally stays
 *  correct if `keepToolResults` changes mid-conversation. The full explanation
 *  is attached only to the first placeholder in a render pass; every
 *  subsequent one gets the short form (near all the token savings, no need to
 *  touch the system prompt / invalidate its cache). */
export function computeLayer1Placeholders(
  messages: ChatMessage[],
  config: RenderConfig,
  projections: Record<string, Projection>,
  protectedIds: Set<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  const keepCut = findKeepPairsCutIndex(messages, config.keepToolResults);
  if (keepCut <= 0) return out;
  const toolNames = buildToolNameIndex(messages);
  let firstAssigned = false;
  for (let i = 0; i < keepCut; i++) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    if (projections[m.id]) continue; // already folded into a block
    if (protectedIds.has(m.id)) continue;
    const name = (m.toolCallId && toolNames.get(m.toolCallId)) || "tool";
    out.set(m.id, firstAssigned ? PLACEHOLDER_SHORT(name) : PLACEHOLDER_FULL(name));
    firstAssigned = true;
  }
  return out;
}

/** Wrap a block's summary the same way a splice-in summary has always been
 *  presented to the model. `includeRecoveryNote` should be true only for the
 *  first block rendered in a pass (repeating it on every block wastes tokens
 *  for no benefit). */
export function buildBlockMessage(block: Block, includeRecoveryNote: boolean): ChatMessage {
  const note = includeRecoveryNote
    ? "\n\nEarlier details from this conversation were compacted. Durable lessons may be retrievable via memory_search."
    : "";
  return {
    id: `block-summary-${block.id}`,
    role: "user",
    content: `<conversation_summary>\n${block.summary.trim()}${note}\n</conversation_summary>`,
  };
}

export interface RenderStats {
  clearedResults: number;
  blocksRendered: number;
  messagesBefore: number;
  messagesAfter: number;
}

export interface RenderResult {
  messages: ChatMessage[];
  stats: RenderStats;
}

/** Full view transform: walk the live transcript once, splicing in each
 *  block's summary the first time one of its members is encountered (and
 *  skipping the rest — including members of a now-evicted block, which are
 *  simply dropped with zero trace), and placeholdering old tool results per
 *  Layer 1. Pure — same message array + same sidecar always yields the same
 *  output. */
export function renderView(messages: ChatMessage[], sidecar: Sidecar, config: RenderConfig): RenderResult {
  const protectedIds = protectedTurnMessageIds(messages, config.unrecoverableTools);
  const placeholders = computeLayer1Placeholders(messages, config, sidecar.projections, protectedIds);

  const out: ChatMessage[] = [];
  const emittedBlocks = new Set<string>();
  let clearedResults = 0;
  let blocksRendered = 0;

  for (const m of messages) {
    const proj = sidecar.projections[m.id];
    if (proj) {
      const block = sidecar.blocks[proj.blockId];
      if (!block || emittedBlocks.has(proj.blockId)) continue; // evicted, or already emitted
      emittedBlocks.add(proj.blockId);
      out.push(buildBlockMessage(block, blocksRendered === 0));
      blocksRendered++;
      continue;
    }
    const placeholder = placeholders.get(m.id);
    if (placeholder !== undefined) {
      out.push({ ...m, content: placeholder });
      clearedResults++;
      continue;
    }
    out.push(m);
  }

  return {
    messages: out,
    stats: { clearedResults, blocksRendered, messagesBefore: messages.length, messagesAfter: out.length },
  };
}
