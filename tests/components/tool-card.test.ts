// 045-chat-live-tool (US3, T009 pure-logic leg): the framework-free card logic in
// src/components/agent/v2/ToolCardSummary.ts. The rendered DOM (header summary,
// independent Input/Output collapse, content-type Output, recursive child cards)
// is covered by the real-browser e2e (e2e/045-chat-live-tool.spec.ts, US3 leg);
// here we pin the decision logic the card is built from, which the e2e can only
// observe indirectly.
//
//   npm run test:unit -- tests/components/tool-card.test.ts

import { test, expect } from "@playwright/test";
import {
  summarizeToolCall,
  argRows,
  primaryArgKey,
  detectOutputMode,
  nestedFromTerminal,
  childrenFromLive,
  parseArgs,
} from "../../src/components/agent/v2/ToolCardSummary";
import { encodeMcpUi } from "../../src/lib/mcp/ui";
import { encodeNested } from "../../src/lib/agent/nested-events";

test.describe("FR-012 — header action summary", () => {
  test("shows a human verb + key argument, not raw JSON", () => {
    const s = summarizeToolCall("file_read", `{"path":"src/foo.ts","opts":{"x":1}}`);
    expect(s.title).toBe("Read file");
    expect(s.detail).toBe("src/foo.ts");
  });

  test("falls back to the raw tool name when no summarizer is known", () => {
    const s = summarizeToolCall("some_obscure_tool", `{"k":"v"}`);
    expect(s.title).toBe("some_obscure_tool");
  });

  test("falls back to the tool name AND omits detail when there is no primary arg", () => {
    const s = summarizeToolCall("run_command", `{"flags":["-a"]}`);
    expect(s.title).toBe("Run command");
    expect(s.detail).toBeUndefined();
  });

  test("picks the first present primary key for a delegation (name > agent > task)", () => {
    const s = summarizeToolCall("agent_delegate", `{"task":"do the thing","ephemeralName":"Helper"}`);
    expect(s.detail).toBe("Helper");
  });
});

test.describe("FR-013 — structured key–value arg rows", () => {
  test("marks the primary arg and lists the rest", () => {
    const rows = argRows("file_read", `{"path":"a.ts","encoding":"utf8"}`);
    expect(rows).toHaveLength(2);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.primary]));
    expect(byKey.path).toBe(true);
    expect(byKey.encoding).toBe(false);
  });

  test("no forced/fabricated primary when there is none (edge case)", () => {
    expect(primaryArgKey("mystery", { a: 1, b: 2 })).toBeNull();
    const rows = argRows("mystery", `{"a":1,"b":2}`);
    expect(rows.some((r) => r.primary)).toBe(false);
  });
});

test.describe("FR-014 — Output content-type precedence", () => {
  test("MCP-UI marker wins (highest precedence)", () => {
    expect(detectOutputMode(encodeMcpUi({ html: "<b>hi</b>" }))).toBe("mcp-ui");
  });

  test("nested-delegation marker → nested", () => {
    expect(detectOutputMode("summary" + encodeNested({ events: [{ tool: "x" }], output: "o" }))).toBe("nested");
  });

  test("strict JSON object → json", () => {
    expect(detectOutputMode(`{"a":1,"b":[1,2]}`)).toBe("json");
  });

  test("strict JSON array → json", () => {
    expect(detectOutputMode(`[1,2,3]`)).toBe("json");
  });

  test("bare JSON string/number is NOT treated as a JSON blob → markdown (graceful)", () => {
    expect(detectOutputMode(`"just a string"`)).toBe("markdown");
    expect(detectOutputMode(`42`)).toBe("markdown");
  });

  test("JSON-looking prose that fails to parse → markdown (never throws)", () => {
    expect(detectOutputMode(`{"broken": `)).toBe("markdown");
    expect(detectOutputMode("# A heading\n- one\n- two")).toBe("markdown");
  });
});

test.describe("B1 — terminal nested projection (parseNested → child cards)", () => {
  const payload =
    "outer summary" +
    encodeNested({
      events: [
        { tool: "memory_search", input: { query: "a" }, result: "found a", status: "done" },
        { tool: "agent_delegate", input: { task: "inner" }, result: "inner " + encodeNested({ events: [{ tool: "docs_read", input: { ref: "r" }, result: "body", status: "done" }], output: "ig" }), status: "done" },
      ],
      output: "final",
    });

  test("builds child cards + the delegation's final output", () => {
    const { children, output } = nestedFromTerminal(payload, "P")!;
    expect(output).toBe("final");
    expect(children).toHaveLength(2);
    expect(children[0]).toMatchObject({ callId: "P:c0", name: "memory_search", status: "done", result: "found a" });
    expect(children[1].name).toBe("agent_delegate");
  });

  test("a delegation child carries its own result string so it recurses", () => {
    const { children } = nestedFromTerminal(payload, "P")!;
    // children[1] is a delegation; re-parsing ITS result yields the grandchild.
    const grand = nestedFromTerminal(children[1].result!, children[1].callId);
    expect(grand).not.toBeNull();
    expect(grand!.children[0].name).toBe("docs_read");
  });
});

test.describe("US2 — live projection (progress[] → child cards)", () => {
  test("folds starts, results and cancels matched by inner callId", () => {
    const progress = [
      { tool: "memory_search", input: { query: "a" }, callId: "i1" },
      { tool: "docs_read", input: { ref: "r" }, callId: "i2" },
      { tool: "memory_search", type: "tool_result", callId: "i1", result: "found a" },
      { tool: "docs_read", type: "tool_cancelled", callId: "i2" },
    ];
    const children = childrenFromLive(progress, "P");
    expect(children).toHaveLength(2);
    expect(children[0]).toMatchObject({ callId: "i1", name: "memory_search", status: "done", result: "found a" });
    expect(children[1]).toMatchObject({ callId: "i2", name: "docs_read", status: "cancelled" });
  });

  test("a start with no result yet stays running (live in-progress child)", () => {
    const children = childrenFromLive([{ tool: "file_read", input: { path: "x" }, callId: "i3" }], "P");
    expect(children[0]).toMatchObject({ callId: "i3", name: "file_read", status: "running" });
    expect(children[0].result).toBeUndefined();
  });

  test("tolerates legacy entries without callId/type (starts-only)", () => {
    const children = childrenFromLive([{ tool: "memory_search", input: { query: "q" } }], "P");
    expect(children).toHaveLength(1);
    expect(children[0].status).toBe("running");
  });
});

test("parseArgs degrades to {} on empty / non-object / malformed input", () => {
  expect(parseArgs("")).toEqual({});
  expect(parseArgs("no json")).toEqual({});
  expect(parseArgs(`[1,2]`)).toEqual({});
  expect(parseArgs(`{"a":1}`)).toEqual({ a: 1 });
});
