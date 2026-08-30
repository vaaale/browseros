// Layer 3: the synchronous hard-limit fallback (truncate.ts). Single pass then
// truncate — no recursion — so these tests exercise truncateChatTail directly
// and forceClearAll as the emergency second pass.
//
//   node --test --experimental-strip-types --conditions=react-server tests/compaction/truncate.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { truncateChatTail, forceClearAll } from "../../src/lib/agent/compaction/truncate";
import { estimateChatTokens } from "../../src/lib/agent/compaction/estimate";
import { buildToolHeavyConversation, assistantToolCall, userMessage, toolResult } from "./fixtures/tool-heavy";

describe("truncate.ts — truncateChatTail", () => {
  it("fits the target budget and keeps the first user message", () => {
    const convo = buildToolHeavyConversation(40);
    const startEst = estimateChatTokens("", convo);
    const target = 2000;
    assert.ok(startEst > target, "precondition: conversation exceeds the target");
    const truncated = truncateChatTail(convo, 4, target);
    const endEst = estimateChatTokens("", truncated);
    assert.ok(endEst <= target * 1.5, `truncated roughly fits: ${endEst} vs target ${target}`);
    assert.ok(truncated.length < convo.length, "truncation reduces message count");
    assert.equal(truncated[0].id, convo[0].id, "first user message is preserved");
  });

  it("preserves pair completeness — no orphan tool-results after truncation", () => {
    const convo = buildToolHeavyConversation(40);
    const truncated = truncateChatTail(convo, 4, 400);
    const callIds = new Set<string>();
    for (const m of truncated) if (m.role === "assistant") for (const tc of m.toolCalls ?? []) callIds.add(tc.id);
    for (const m of truncated) {
      if (m.role !== "tool" || !m.toolCallId) continue;
      assert.ok(callIds.has(m.toolCallId), `orphan tool-result: ${m.toolCallId}`);
    }
  });

  it("is a no-op for a 1-or-fewer-message transcript", () => {
    const convo = [userMessage("hi")];
    assert.deepEqual(truncateChatTail(convo, 4, 10), convo);
  });
});

describe("truncate.ts — forceClearAll", () => {
  it("clears every tool result, including ones inside the normal recency window", () => {
    const convo = buildToolHeavyConversation(3);
    const { messages, cleared } = forceClearAll(convo, []);
    // Turn 0 is pinned — its tool-result is exempt; turns 1-2's are cleared.
    assert.equal(cleared, 2);
    const toolMsgs = messages.filter((m) => m.role === "tool");
    assert.equal(toolMsgs[0].content, convo.find((m) => m.role === "tool")!.content, "turn 0's tool-result untouched (pinned)");
    assert.ok(toolMsgs[1].content?.includes("elided"));
    assert.ok(toolMsgs[2].content?.includes("elided"));
  });

  it("never clears a call to an unrecoverable tool, even in the emergency pass", () => {
    const convo = [
      userMessage("turn 0"),
      ...(() => {
        const { message, callId } = assistantToolCall("send_payment", { amount: 100 });
        return [message, toolResult(callId, "payment sent, confirmation #123")];
      })(),
      userMessage("turn 1"),
      ...(() => {
        const { message, callId } = assistantToolCall("read_file", { path: "/tmp/x" });
        return [message, toolResult(callId, "file contents...")];
      })(),
    ];
    const { messages, cleared } = forceClearAll(convo, ["send_payment"]);
    // Turn 0 (send_payment) is protected — both as the pinned first turn AND
    // as an unrecoverable-tool turn. Turn 1 (read_file) has no such protection,
    // so it's the only one cleared.
    assert.equal(cleared, 1);
    const paymentResult = messages.find((m) => m.role === "tool" && m.content?.includes("confirmation"));
    assert.ok(paymentResult, "send_payment's result survives verbatim");
    const readResult = messages.find((m) => m.role === "tool" && m.content?.includes("elided"));
    assert.ok(readResult, "read_file's result was cleared");
  });
});
