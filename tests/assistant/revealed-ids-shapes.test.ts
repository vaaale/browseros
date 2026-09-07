// Reveal derivation (041 ADR-4 / R1 / R9). This is the highest-risk edit in the
// feature because it fails SILENTLY: if derivation stops recognising a
// find_tools result, deferred tools simply never become callable and nothing
// throws.
//
// Two invariants:
//   1. Both payload shapes work FOREVER — the pre-041 bare array and the 041
//      envelope. Transcripts are replayed from disk and never rewritten.
//   2. Derivation reads the CANONICAL transcript, not the compacted model view.
//      Compaction clears older tool results from what the model sees; the
//      reveal must survive that.
//   npx playwright test -c playwright.unit.config.ts tests/assistant/revealed-ids-shapes.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { deriveRevealedIds, idsFromFindToolsPayload } from "../../src/lib/assistant/messages";
import type { ChatMessage } from "../../src/lib/assistant/messages";

const LEGACY = JSON.stringify([
  { id: "web_search", group: "Web", description: "…", schema: { type: "object" }, score: 12 },
  { id: "web_fetch", group: "Web", description: "…", schema: { type: "object" }, score: 9 },
]);

const ENVELOPE = JSON.stringify({
  results: [
    { id: "gmail_messages_send", group: "Gmail", description: "…", reasons: [{ term: "email", field: "alias" }] },
  ],
  totalMatches: 3,
  withheld: 2,
  alreadyVisible: [{ id: "file_read", group: "Files", description: "…" }],
  groups: [{ id: "web", name: "Web", description: "…", hiddenTools: 2 }],
});

function transcript(...payloads: string[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  payloads.forEach((content, i) => {
    const callId = `call-${i}`;
    out.push({
      id: `a-${i}`,
      role: "assistant",
      content: "",
      toolCalls: [{ id: callId, type: "function", function: { name: "find_tools", arguments: "{}" } }],
    } as ChatMessage);
    out.push({ id: `t-${i}`, role: "tool", toolCallId: callId, content } as ChatMessage);
  });
  return out;
}

// ── Payload shapes ──────────────────────────────────────────────────────────

test("the legacy bare array still reveals (old conversations replay forever)", () => {
  expect(idsFromFindToolsPayload(JSON.parse(LEGACY))).toEqual(["web_search", "web_fetch"]);
});

test("the 041 envelope reveals from results", () => {
  expect(idsFromFindToolsPayload(JSON.parse(ENVELOPE))).toEqual(["gmail_messages_send"]);
});

test("results is the ONLY reveal source — alreadyVisible and groups are not grants", () => {
  const ids = idsFromFindToolsPayload(JSON.parse(ENVELOPE));
  expect(ids).not.toContain("file_read"); // alreadyVisible
  expect(ids).not.toContain("web"); // groups
});

test("a malformed or unexpected payload reveals nothing rather than throwing", () => {
  expect(idsFromFindToolsPayload(null)).toEqual([]);
  expect(idsFromFindToolsPayload({})).toEqual([]);
  expect(idsFromFindToolsPayload({ results: "not an array" })).toEqual([]);
  expect(idsFromFindToolsPayload([{ notAnId: 1 }, { id: 42 }, { id: "" }])).toEqual([]);
});

test("a transcript mixing both shapes reveals the union", () => {
  const revealed = deriveRevealedIds(transcript(LEGACY, ENVELOPE));
  expect([...revealed].sort()).toEqual(["gmail_messages_send", "web_fetch", "web_search"]);
});

// ── R9: canonical transcript vs compacted view ──────────────────────────────

test("reveals survive compaction clearing the tool result from the model view", () => {
  const canonical = transcript(ENVELOPE);

  // What compaction Layer 1 does to the MODEL VIEW: older tool results are
  // cleared. agent-loop.ts passes this as `contextMessages` while deriving
  // reveals from `messages` — so the tool stays callable.
  const compactedView = canonical.map((m) =>
    m.role === "tool" ? ({ ...m, content: "[tool result cleared to save context]" } as ChatMessage) : m,
  );

  expect(deriveRevealedIds(canonical).has("gmail_messages_send")).toBe(true);
  // Proof the distinction is load-bearing: deriving from the view instead would
  // silently un-reveal the tool. If this expectation ever flips, someone has
  // "tidied" agent-loop.ts:294 from `messages` to `contextMessages`.
  expect(deriveRevealedIds(compactedView).has("gmail_messages_send")).toBe(false);
});

// ── Scoping ─────────────────────────────────────────────────────────────────

test("only find_tools results reveal — another tool returning ids does not", () => {
  const messages: ChatMessage[] = [
    {
      id: "a",
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", type: "function", function: { name: "agent_list", arguments: "{}" } }],
    } as ChatMessage,
    { id: "t", role: "tool", toolCallId: "c1", content: JSON.stringify([{ id: "run_command" }]) } as ChatMessage,
  ];
  expect(deriveRevealedIds(messages).size).toBe(0);
});
