// 045-chat-live-tool (US3) — pure, framework-free presentation logic for the
// recursive tool-call card. Kept JSX-free so it is unit-testable in Node
// (tests/components/tool-card.test.ts) and reusable at every nesting depth.
//
// Covers: the header action summary (FR-012), the structured key–value arg rows
// (FR-013), the Output content-type decision (FR-014), and the projection of a
// delegation's nested work into child-card data from BOTH the terminal payload
// (parseNested, B1) and the live progress[] (US2).

import { parseMcpUi } from "@/lib/mcp/ui";
import { parseNested, type NestedEvent } from "@/lib/agent/nested-events";

export type CardStatus = "running" | "done" | "cancelled";

// A child tool-call card, built from either the terminal nested payload or the
// live progress projection. The same shape as a top-level ToolCardData (see
// ToolCallCard.tsx) so the card recurses on it identically.
export interface ChildCardData {
  callId: string;
  name: string;
  args: string;
  status: CardStatus;
  result?: string;
  progress?: unknown[];
}

// ── Arg parsing ──────────────────────────────────────────────────────────────

export function parseArgs(args: string): Record<string, unknown> {
  if (!args) return {};
  try {
    const v: unknown = JSON.parse(args);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Serialize a (possibly already-parsed) input value to the card's args string. */
export function inputToString(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function truncate(s: string, max = 80): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ── Header action summary (FR-012) ───────────────────────────────────────────

const VERBS: Record<string, string> = {
  file_read: "Read file",
  file_write: "Write file",
  file_edit: "Edit file",
  file_list: "List files",
  file_grep: "Search files",
  file_mkdir: "Make directory",
  file_delete: "Delete file",
  web_search: "Web search",
  web_fetch: "Fetch URL",
  memory_search: "Memory search",
  memory_get: "Memory",
  memory_store: "Remember",
  run_command: "Run command",
  agent_delegate: "Delegate",
  dev_delegate: "Delegate",
  bos_source_read: "Read source",
  bos_source_list: "List source",
  bos_source_search: "Search source",
  docs_read: "Read doc",
  find_tools: "Find tools",
  find_agent: "Find agent",
  app_launch: "Launch app",
};

// Which argument is "the thing the tool acts on" for a given tool, in priority
// order. A tool with no recognizable primary shows a clean key–value list with
// none emphasized (spec edge case: "Args with no clear primary").
const PRIMARY_KEYS: Record<string, string[]> = {
  file_read: ["path"],
  file_write: ["path"],
  file_edit: ["path"],
  file_list: ["path"],
  file_grep: ["pattern", "path"],
  web_search: ["query"],
  web_fetch: ["url"],
  memory_search: ["query"],
  run_command: ["command"],
  agent_delegate: ["ephemeralName", "agent", "task"],
  dev_delegate: ["ephemeralName", "agent", "task"],
  bos_source_read: ["path"],
  bos_source_list: ["path"],
  bos_source_search: ["query", "pattern"],
  docs_read: ["ref", "path"],
  find_tools: ["query"],
  find_agent: ["query"],
  app_launch: ["appId", "id"],
};

const GENERIC_PRIMARY = ["path", "query", "url", "id", "command", "ref", "task", "pattern", "prompt"];

export function primaryArgKey(name: string, obj: Record<string, unknown>): string | null {
  const list = [...(PRIMARY_KEYS[name] ?? []), ...GENERIC_PRIMARY];
  for (const k of list) if (k in obj) return k;
  return null;
}

/** One-line header: a human verb (or the raw tool name as fallback) + the key
 *  argument. NEVER a raw JSON blob (FR-012, SC-006). */
export function summarizeToolCall(name: string, args: string): { title: string; detail?: string } {
  const obj = parseArgs(args);
  const detailKey = primaryArgKey(name, obj);
  const detail =
    detailKey != null && typeof obj[detailKey] === "string" && (obj[detailKey] as string).trim() !== ""
      ? truncate(obj[detailKey] as string)
      : undefined;
  return { title: VERBS[name] ?? name, detail };
}

// ── Structured key–value arg rows (FR-013) ───────────────────────────────────

export interface ArgRow {
  key: string;
  value: unknown;
  primary: boolean;
}

export function argRows(name: string, args: string): ArgRow[] {
  const obj = parseArgs(args);
  const primaryKey = primaryArgKey(name, obj);
  return Object.entries(obj).map(([key, value]) => ({ key, value, primary: key === primaryKey }));
}

// ── Output content type (FR-014) ─────────────────────────────────────────────

export type OutputMode = "mcp-ui" | "nested" | "json" | "markdown";

/** Strict JSON object/array check — a bare JSON string/number is NOT treated as
 *  a JSON blob (falls through to markdown/text), and any parse error degrades to
 *  markdown rather than throwing (spec: "ambiguous content" / "best-effort"). */
function isJsonObjectOrArray(text: string): boolean {
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return false;
  try {
    const v: unknown = JSON.parse(t);
    return v !== null && typeof v === "object";
  } catch {
    return false;
  }
}

/** Fixed precedence (FR-014 / design N3): MCP-UI marker → nested-delegation
 *  marker → strict JSON object/array → markdown. */
export function detectOutputMode(result: string): OutputMode {
  if (parseMcpUi(result)) return "mcp-ui";
  if (parseNested(result)) return "nested";
  if (isJsonObjectOrArray(result)) return "json";
  return "markdown";
}

// ── Delegation → child-card projection (US2 live / B1 terminal) ──────────────

function nestedToChild(ev: NestedEvent, callId: string): ChildCardData {
  return {
    callId,
    name: ev.tool,
    args: inputToString(ev.input),
    status: ev.status ?? "done",
    result: ev.result,
  };
}

/** Terminal: rebuild the full child-card tree from the persisted nested payload
 *  (parseNested). Each child that is itself a delegation carries its own result
 *  string, so recursion is realized by the child card re-parsing its result. */
export function nestedFromTerminal(result: string, parentCallId: string): { children: ChildCardData[]; output: string } | null {
  const parsed = parseNested(result);
  if (!parsed) return null;
  return {
    children: parsed.events.map((ev, i) => nestedToChild(ev, `${parentCallId}:c${i}`)),
    output: parsed.output,
  };
}

/** Live: fold the in-flight progress[] (start/result/cancel, discriminated by
 *  type; matched by inner callId when present) into child-card data. A child
 *  that is still running keeps status "running" (and its Output shows a
 *  spinner); once its result arrives it flips done. */
export function childrenFromLive(progress: unknown[], parentCallId: string): ChildCardData[] {
  const byId = new Map<string, ChildCardData>();
  const order: string[] = [];
  let anon = 0;
  for (const raw of progress) {
    const e = raw as { tool?: string; input?: unknown; callId?: string; type?: string; result?: string };
    if (!e || typeof e.tool !== "string") continue;
    const id = e.callId ?? `${parentCallId}:t${e.tool}-${anon++}`;
    let child = byId.get(id);
    if (!child) {
      child = { callId: id, name: e.tool, args: inputToString(e.input), status: "running" };
      byId.set(id, child);
      order.push(id);
    }
    if (e.type === "tool_result") {
      child.status = "done";
      child.result = e.result;
    } else if (e.type === "tool_cancelled") {
      child.status = "cancelled";
    }
  }
  return order.map((id) => byId.get(id)!);
}
