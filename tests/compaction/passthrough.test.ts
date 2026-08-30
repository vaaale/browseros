// Pass-through / determinism for the render layer. The "below clearThreshold,
// return the input byte-identically" behavior itself lives one layer up in
// v2.ts's compactChatMessages (an early-return before renderView is ever
// called) — v2.ts pulls in config/logging modules that hit a pre-existing,
// unrelated Node type-stripping limitation in this environment (a
// non-erasable "parameter property" in src/lib/logging), so it isn't unit-
// tested directly here. What IS tested: renderView itself is a pure,
// deterministic function of (messages, sidecar, config) — the same inputs
// always produce the same output, and an empty sidecar with nothing eligible
// to clear leaves ordinary content untouched.
//
//   node --test --experimental-strip-types --conditions=react-server tests/compaction/passthrough.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { renderView } from "../../src/lib/agent/compaction/render";
import type { Sidecar } from "../../src/lib/agent/compaction/sidecar";
import { buildTinyConversation } from "./fixtures/tool-heavy";

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

describe("render.ts — pass-through / determinism", () => {
  it("a small conversation with no tool results renders with identical content", () => {
    const messages = buildTinyConversation();
    const result = renderView(messages, emptySidecar(), { keepToolResults: 2, unrecoverableTools: [] });
    assert.deepEqual(result.messages, messages);
    assert.equal(result.stats.clearedResults, 0);
    assert.equal(result.stats.blocksRendered, 0);
  });

  it("is deterministic across repeated invocations", () => {
    const messages = buildTinyConversation();
    const a = renderView(messages, emptySidecar(), { keepToolResults: 2, unrecoverableTools: [] });
    const b = renderView(messages, emptySidecar(), { keepToolResults: 2, unrecoverableTools: [] });
    assert.deepEqual(a.messages, b.messages);
  });
});
