// 045-chat-live-tool (Foundational, T002): the widened NestedEvent payload
// round-trips through encodeNested/parseNested. The delegation tool_result is
// a STRING that the card rebuilds its nested child-card tree from (after a
// reload, when the live progress[] is empty) — so the payload MUST carry
// per-child result?/status?/nested? (recursion by structure), not just the
// legacy { tool, input } starts + one shared output.
//
// The NESTED_MARKER byte and the encodeNested/parseNested entry points are
// unchanged (FR-007: a payload-SHAPE change, not a new event type); only the
// shape of the events entries widens. parseNested must also still tolerate
// legacy { tool, input }-only payloads (existing runs, and the claude path
// which is starts-only).
//   npm run test:unit -- tests/agent/nested-events.test.ts

import { test, expect } from "@playwright/test";
import {
  NESTED_MARKER,
  encodeNested,
  parseNested,
  type NestedEvent,
} from "../../src/lib/agent/nested-events";

// A nested delegation three levels deep: the grandchild carries its own result
// and status, so a done delegation's child-card tree rebuilds from the persisted
// string alone (SC-010: navigable ≥3 levels with no structural change).
const TREE: NestedEvent[] = [
  {
    tool: "agent_delegate",
    input: { task: "outer" },
    result: "outer done",
    status: "done",
    nested: [
      {
        tool: "memory_search",
        input: { query: "a" },
        result: "found a",
        status: "done",
      },
      {
        tool: "agent_delegate",
        input: { task: "inner" },
        result: "inner done",
        status: "done",
        nested: [
          { tool: "docs_read", input: { ref: "r" }, result: "the doc", status: "done" },
        ],
      },
    ],
  },
  { tool: "memory_search", input: { query: "b" }, status: "running" },
];

test("NESTED_MARKER is a stable, non-empty sentinel", () => {
  expect(typeof NESTED_MARKER).toBe("string");
  expect(NESTED_MARKER.length).toBeGreaterThan(0);
});

test("encode → parse round-trips result?, status? and a nested? tree at depth ≥3", () => {
  const encoded = encodeNested({ events: TREE, output: "final answer" });
  expect(encoded.startsWith(NESTED_MARKER)).toBe(true);

  const parsed = parseNested(encoded);
  expect(parsed).not.toBeNull();
  expect(parsed!.output).toBe("final answer");
  expect(parsed!.events).toHaveLength(2);

  const outer = parsed!.events[0];
  expect(outer.tool).toBe("agent_delegate");
  expect(outer.result).toBe("outer done");
  expect(outer.status).toBe("done");
  expect(outer.nested).toHaveLength(2);

  const grandchild = outer.nested![1].nested![0];
  expect(grandchild.tool).toBe("docs_read");
  expect(grandchild.result).toBe("the doc");
  expect(grandchild.status).toBe("done");

  // The still-running child round-trips its status with no fabricated result.
  expect(parsed!.events[1].status).toBe("running");
  expect(parsed!.events[1].result).toBeUndefined();
});

test("legacy { tool, input }-only payloads still parse (new fields absent, not fabricated)", () => {
  const legacy = encodeNested({
    events: [
      { tool: "memory_search", input: { query: "x" } },
      { tool: "docs_read", input: { ref: "y" } },
    ],
    output: "legacy output",
  });
  const parsed = parseNested(legacy);
  expect(parsed).not.toBeNull();
  expect(parsed!.events[0].tool).toBe("memory_search");
  expect(parsed!.events[0].input).toEqual({ query: "x" });
  expect(parsed!.events[0].result).toBeUndefined();
  expect(parsed!.events[0].status).toBeUndefined();
  expect(parsed!.events[0].nested).toBeUndefined();
});

test("parseNested returns null for non-nested and malformed values", () => {
  expect(parseNested("plain prose result")).toBeNull();
  expect(parseNested(NESTED_MARKER + "not-json")).toBeNull();
  expect(parseNested(NESTED_MARKER + '{"output":"no events"}')).toBeNull();
});
