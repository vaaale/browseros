// Multimodal message support:
//   npx playwright test -c playwright.unit.config.ts

import { test } from "@playwright/test";
import { strict as assert } from "node:assert";

import { runAgentLoop, type AgentLoopDeps } from "../../src/lib/assistant/agent-loop";
import type { ChatMessage, Attachment } from "../../src/lib/assistant/messages";

function openGate() {
  return { allow: new Set<string>(), deferred: new Set<string>(), registryIds: new Set<string>(), descriptions: {} };
}

const IMG: Attachment = { type: "image", mimeType: "image/png", data: "aGVsbG8=", name: "shot.png" };

test.describe("multimodal — loop persistence", () => {
  test("attachments on the user message are persisted and passed to the provider", async () => {
    const store = { messages: [] as ChatMessage[] };
    let sawAttachmentInTurn = false;
    const deps: AgentLoopDeps = {
      runId: "r1",
      conversationId: "", // empty → compaction is a no-op, so the turn sees the raw messages
      agentId: "a1",
      signal: new AbortController().signal,
      emit: () => undefined,
      streamTurn: async (opts) => {
        const lastUser = [...opts.messages].reverse().find((m) => m.role === "user");
        sawAttachmentInTurn = (lastUser?.attachments?.length ?? 0) > 0;
        return { text: "I see the image.", toolCalls: [] };
      },
      composeSystem: async () => "system",
      tools: {},
      gate: openGate(),
      io: {
        loadMessages: async () => [...store.messages],
        saveMessages: async (m) => {
          store.messages = [...m];
        },
      },
      awaitFrontendResult: async () => ({ kind: "timeout" }),
      maxSteps: 4,
      toolTimeoutMs: 500,
    };
    const result = await runAgentLoop(deps, { userMessage: { content: "what is this?", attachments: [IMG] } });
    assert.equal(result.reason, "completed");
    assert.ok(sawAttachmentInTurn, "the provider turn must receive the attachment");
    const userMsg = store.messages.find((m) => m.role === "user")!;
    assert.equal(userMsg.attachments?.length, 1);
    assert.equal(userMsg.attachments![0].mimeType, "image/png");
  });
});
