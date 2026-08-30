// Turn-boundary helpers (turns.ts), native to ChatMessage[]. These underpin
// every layer (Layer 1's recency window, Layer 2's block eligibility, Layer 3's
// tail sizing), so their correctness matters broadly.
//
//   node --test --experimental-strip-types --conditions=react-server tests/compaction/turns.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  turnStarts,
  firstUserMessageId,
  protectedTurnMessageIds,
  findKeepPairsCutIndex,
  findTailCutIndex,
} from "../../src/lib/agent/compaction/turns";
import { buildToolHeavyConversation, userMessage, assistantText, assistantToolCall } from "./fixtures/tool-heavy";

describe("turns.ts", () => {
  it("turnStarts finds every user-message index", () => {
    const convo = buildToolHeavyConversation(5); // 4 messages per turn
    const starts = turnStarts(convo);
    assert.equal(starts.length, 5);
    for (const idx of starts) assert.equal(convo[idx].role, "user");
  });

  it("firstUserMessageId returns the first turn's user message id", () => {
    const convo = buildToolHeavyConversation(3);
    assert.equal(firstUserMessageId(convo), convo[0].id);
  });

  it("protectedTurnMessageIds always protects the whole first turn", () => {
    const convo = buildToolHeavyConversation(3);
    const protectedIds = protectedTurnMessageIds(convo, []);
    // First turn = messages[0..4) — all 4 must be protected.
    for (const m of convo.slice(0, 4)) assert.ok(protectedIds.has(m.id), `turn-0 message ${m.id} should be protected`);
    // A later turn's messages must NOT be protected (no unrecoverable tools configured).
    for (const m of convo.slice(4, 8)) assert.ok(!protectedIds.has(m.id), `turn-1 message ${m.id} should not be protected`);
  });

  it("protectedTurnMessageIds protects any turn calling an unrecoverable tool", () => {
    const convo = [
      userMessage("turn 0"),
      assistantText("ok"),
      userMessage("turn 1 — do something unrecoverable"),
      ...(() => {
        const { message } = assistantToolCall("delete_forever", { id: 1 });
        return [message];
      })(),
      userMessage("turn 2"),
      assistantText("ok"),
    ];
    const protectedIds = protectedTurnMessageIds(convo, ["delete_forever"]);
    // Turn 0 (pinned intent) protected.
    assert.ok(protectedIds.has(convo[0].id));
    assert.ok(protectedIds.has(convo[1].id));
    // Turn 1 protected because it calls the unrecoverable tool.
    assert.ok(protectedIds.has(convo[2].id));
    assert.ok(protectedIds.has(convo[3].id));
    // Turn 2 not protected.
    assert.ok(!protectedIds.has(convo[4].id));
    assert.ok(!protectedIds.has(convo[5].id));
  });

  it("findKeepPairsCutIndex keeps exactly the newest N tool-call pairs", () => {
    const convo = buildToolHeavyConversation(5); // 5 tool-call pairs, one per turn
    const cut = findKeepPairsCutIndex(convo, 2);
    // Count tool-call-bearing assistant messages at/after cut.
    let pairsAtOrAfter = 0;
    for (let i = cut; i < convo.length; i++) {
      const m = convo[i];
      if (m.role === "assistant" && m.toolCalls?.length) pairsAtOrAfter++;
    }
    assert.equal(pairsAtOrAfter, 2, "exactly the newest 2 pairs are at/after the cut");
  });

  it("findKeepPairsCutIndex returns the full length when keepN <= 0", () => {
    const convo = buildToolHeavyConversation(3);
    assert.equal(findKeepPairsCutIndex(convo, 0), convo.length);
  });

  it("findTailCutIndex always lands on a turn boundary (user message)", () => {
    const convo = buildToolHeavyConversation(10);
    const cut = findTailCutIndex(convo, 3, 0.2, 800);
    assert.ok(cut >= 0 && cut <= convo.length);
    if (cut < convo.length) assert.equal(convo[cut].role, "user", "tail cut lands on a user message");
  });

  it("findTailCutIndex grows the tail to satisfy the minimum turn count", () => {
    const convo = buildToolHeavyConversation(10);
    const cut = findTailCutIndex(convo, 4, 0, 0); // no token pressure — pure turn-count floor
    const starts = turnStarts(convo);
    const turnsKept = starts.filter((s) => s >= cut).length;
    assert.equal(turnsKept, 4, "keeps exactly keepTailTurns turns when token budget is 0");
  });
});
