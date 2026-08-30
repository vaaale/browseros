// The pure view transform (render.ts) — replaces the old view.ts's
// applyView/applyLayer1Clearing/buildSummaryMessage. Single pass over the live
// transcript: Layer 1 placeholders (recomputed fresh every render) and Layer 2
// block splicing (persisted, id-keyed) in one loop.
//
//   node --test --experimental-strip-types --conditions=react-server tests/compaction/render.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { renderView, computeLayer1Placeholders, buildBlockMessage } from "../../src/lib/agent/compaction/render";
import { protectedTurnMessageIds } from "../../src/lib/agent/compaction/turns";
import type { Sidecar, Block } from "../../src/lib/agent/compaction/sidecar";
import { buildToolHeavyConversation, userMessage, assistantText } from "./fixtures/tool-heavy";

function emptySidecar(): Sidecar {
  return {
    version: 2,
    projections: {},
    blocks: {},
    blockOrder: [],
    lock: null,
    updatedAt: new Date(0).toISOString(),
    stats: { estimatedTokens: 0, compactedAt: new Date(0).toISOString(), runs: 0 },
  };
}

function makeBlock(id: string, memberIds: string[], summary = "a summary"): Block {
  return { id, summary, memberIds, turnCount: 1, createdAt: new Date(0).toISOString() };
}

describe("render.ts — computeLayer1Placeholders", () => {
  it("clears tool results older than the keepToolResults window, first gets full text, rest short", () => {
    const convo = buildToolHeavyConversation(5); // 5 tool-result messages, one per turn
    const protectedIds = protectedTurnMessageIds(convo, []);
    const placeholders = computeLayer1Placeholders(convo, { keepToolResults: 2, unrecoverableTools: [] }, {}, protectedIds);
    const toolMsgs = convo.filter((m) => m.role === "tool");
    // Turn 0 is pinned (protected) regardless of recency, so it's never
    // placeholdered; newest 2 pairs (turns 3,4) are kept verbatim by the
    // recency window — only turns 1 and 2's tool-results are eligible.
    const eligible = [toolMsgs[1], toolMsgs[2]];
    assert.equal(placeholders.size, 2);
    assert.ok(!placeholders.has(toolMsgs[0].id), "turn 0's tool-result is pinned, never placeholdered");
    const values = eligible.map((m) => placeholders.get(m.id));
    assert.ok(values[0]?.includes("re-run the tool"), "first placeholder has the full explanation");
    assert.ok(!values[1]?.includes("re-run the tool"), "second placeholder is short");
  });

  it("never placeholders a message already grouped into a block", () => {
    const convo = buildToolHeavyConversation(3);
    const toolMsg = convo.find((m) => m.role === "tool")!;
    const projections = { [toolMsg.id]: { blockId: "b1" } };
    const protectedIds = protectedTurnMessageIds(convo, []);
    const placeholders = computeLayer1Placeholders(convo, { keepToolResults: 0, unrecoverableTools: [] }, projections, protectedIds);
    assert.ok(!placeholders.has(toolMsg.id), "grouped message is skipped by Layer 1");
  });

  it("never placeholders a protected (pinned or unrecoverable-tool) turn", () => {
    const convo = buildToolHeavyConversation(3);
    const protectedIds = protectedTurnMessageIds(convo, []);
    const placeholders = computeLayer1Placeholders(convo, { keepToolResults: 0, unrecoverableTools: [] }, {}, protectedIds);
    const firstTurnTool = convo[2]; // turn 0's tool-result message
    assert.equal(firstTurnTool.role, "tool");
    assert.ok(!placeholders.has(firstTurnTool.id), "first-turn tool result is never placeholdered");
  });
});

describe("render.ts — renderView", () => {
  it("passes non-tool-result content through untouched with an empty sidecar", () => {
    const convo = [userMessage("hi"), assistantText("hello")];
    const result = renderView(convo, emptySidecar(), { keepToolResults: 2, unrecoverableTools: [] });
    assert.deepEqual(result.messages, convo);
    assert.equal(result.stats.clearedResults, 0);
    assert.equal(result.stats.blocksRendered, 0);
  });

  it("a block's members collapse to exactly one emitted message, at the first member's position", () => {
    const convo = buildToolHeavyConversation(2); // turn 0 (4 msgs) + turn 1 (4 msgs)
    const turn0 = convo.slice(0, 4);
    const sidecar = emptySidecar();
    sidecar.blocks[ "b1" ] = makeBlock("b1", turn0.map((m) => m.id), "turn 0, compacted");
    sidecar.blockOrder = ["b1"];
    for (const m of turn0) sidecar.projections[m.id] = { blockId: "b1" };

    const result = renderView(convo, sidecar, { keepToolResults: 2, unrecoverableTools: [] });
    // 4 raw turn-0 messages -> 1 block message; turn 1's 4 messages pass through.
    assert.equal(result.messages.length, 1 + 4);
    assert.ok(result.messages[0].content?.includes("turn 0, compacted"));
    assert.equal(result.stats.blocksRendered, 1);
  });

  it("a grouped message whose block was evicted renders with zero trace", () => {
    const convo = buildToolHeavyConversation(2);
    const turn0 = convo.slice(0, 4);
    const sidecar = emptySidecar();
    // Projections point at a block that does NOT exist in sidecar.blocks (evicted).
    for (const m of turn0) sidecar.projections[m.id] = { blockId: "evicted-block" };

    const result = renderView(convo, sidecar, { keepToolResults: 2, unrecoverableTools: [] });
    assert.equal(result.messages.length, 4, "only turn 1's messages remain");
    assert.ok(!result.messages.some((m) => turn0.some((t) => t.id === m.id)));
  });

  it("only the first rendered block gets the durable-memory recovery note", () => {
    const convo = buildToolHeavyConversation(3);
    const [t0, t1] = [convo.slice(0, 4), convo.slice(4, 8)];
    const sidecar = emptySidecar();
    sidecar.blocks.b1 = makeBlock("b1", t0.map((m) => m.id), "block one");
    sidecar.blocks.b2 = makeBlock("b2", t1.map((m) => m.id), "block two");
    sidecar.blockOrder = ["b1", "b2"];
    for (const m of t0) sidecar.projections[m.id] = { blockId: "b1" };
    for (const m of t1) sidecar.projections[m.id] = { blockId: "b2" };

    const result = renderView(convo, sidecar, { keepToolResults: 2, unrecoverableTools: [] });
    const noteCount = result.messages.filter((m) => m.content?.includes("memory_search")).length;
    assert.equal(noteCount, 1, "recovery note appears exactly once, on the first block");
  });

  it("pair completeness: no tool-result ever references a toolCallId not present among rendered assistant tool-calls", () => {
    const convo = buildToolHeavyConversation(8);
    const sidecar = emptySidecar();
    const result = renderView(convo, sidecar, { keepToolResults: 2, unrecoverableTools: [] });
    const callIds = new Set<string>();
    for (const m of result.messages) if (m.role === "assistant") for (const tc of m.toolCalls ?? []) callIds.add(tc.id);
    for (const m of result.messages) {
      if (m.role !== "tool" || !m.toolCallId) continue;
      assert.ok(callIds.has(m.toolCallId), `orphan tool-result: ${m.toolCallId}`);
    }
  });
});

describe("render.ts — buildBlockMessage", () => {
  it("wraps the summary in <conversation_summary> and optionally the recovery note", () => {
    const block = makeBlock("b1", ["m1"], "**User intent** — none");
    const withNote = buildBlockMessage(block, true);
    assert.match(withNote.content ?? "", /<conversation_summary>/);
    assert.match(withNote.content ?? "", /<\/conversation_summary>/);
    assert.match(withNote.content ?? "", /memory_search/);

    const withoutNote = buildBlockMessage(block, false);
    assert.doesNotMatch(withoutNote.content ?? "", /memory_search/);
  });
});
