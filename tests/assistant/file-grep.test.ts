// file_grep — single-file content search (043-file-grep, self-heal case 0002).
//   npx playwright test -c playwright.unit.config.ts tests/assistant/file-grep.test.ts
//
// The defect this feature fixes: `file_search` is a directory-subtree search,
// so pointing it at a FILE silently returns `[]` (walkFiles swallows the
// readdir error) and no tool can grep one named file. These tests pin the
// fixed contract: `file_grep` greps exactly one file (1-based line numbers,
// path:line:text rows), fails LOUDLY on any non-file target (FR-008), is not
// extension-gated (FR-009), and is bounded with disclosed truncation (FR-011).
// Written before the implementation — on the unfixed base fileTools() has no
// `file_grep`, so every test here fails (NFR-004 / SC-009).

import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { chmodSync } from "fs";
import { useTestDataDir } from "../services/_test-env";
import { fileTools } from "../../src/lib/assistant/tools/server/files";
import { discoveryTools } from "../../src/lib/assistant/tools/server/discovery";
import { setInRunAgent, clearInRunAgent } from "../../src/lib/agent/subagents/in-run-agents";
import { listCapabilities } from "../../src/lib/agent/capabilities-registry";
import { writeText, writeBuffer, hostPath } from "../../src/os/vfs";
import type { Agent } from "../../src/lib/agent/subagents/types";
import type { AssistantTool, ToolContext } from "../../src/lib/assistant/tools";

const RUN_ID = "run-file-grep";
const LAB = "/Documents/grep-lab";

const ctx = { conversationId: RUN_ID, runId: RUN_ID, agentId: "ephemeral-test" } as unknown as ToolContext;

async function run(tool: string, input: Record<string, unknown>): Promise<string> {
  const raw = await fileTools()[tool].execute!(input, ctx);
  return typeof raw === "string" ? raw : raw.text;
}

interface GrepRow {
  path: string;
  line: number;
  text: string;
  context?: boolean;
}
interface GrepResult {
  path: string;
  matchCount: number;
  matches: GrepRow[];
  message?: string;
  truncated?: string;
}

async function grep(input: Record<string, unknown>): Promise<GrepResult> {
  const raw = await run("file_grep", input);
  expect(raw, `expected a JSON result, got: ${raw}`).not.toMatch(/^Error:/);
  return JSON.parse(raw) as GrepResult;
}

let env: { dir: string; cleanup: () => void };
test.beforeEach(() => {
  env = useTestDataDir("file-grep");
});
test.afterEach(() => {
  env.cleanup();
});

// ── US1: grep one named file, line-numbered matches (FR-001/002/005, SC-001) ─

test("returns exactly the matching lines with 1-based line numbers, single file only", async () => {
  const file = `${LAB}/a.txt`;
  await writeText(file, ["alpha", "beta", "foo bar", "gamma", "delta", "epsilon", "also foo here", "zeta"].join("\n"));
  // A sibling file that also matches — must NOT leak into the result.
  await writeText(`${LAB}/b.txt`, "foo SIBLING_SENTINEL\n");

  const out = await grep({ path: file, pattern: "foo" });
  expect(out.matchCount).toBe(2);
  expect(out.matches.map((m) => m.line)).toEqual([3, 7]);
  expect(out.matches[0]).toMatchObject({ path: file, line: 3, text: "foo bar" });
  expect(out.matches[1]).toMatchObject({ path: file, line: 7, text: "also foo here" });
  expect(out.truncated).toBeUndefined();
  expect(JSON.stringify(out)).not.toContain("SIBLING_SENTINEL");
});

test("a valid file with no matches is a clean zero-match result, not an error (FR-010, SC-003)", async () => {
  const file = `${LAB}/none.txt`;
  await writeText(file, "alpha\nbeta\n");
  const out = await grep({ path: file, pattern: "zzz" });
  expect(out.matchCount).toBe(0);
  expect(out.matches).toEqual([]);
  expect(String(out.message)).toMatch(/no match/i);
});

test("an empty file is a valid target with a clean zero-match (edge case)", async () => {
  const file = `${LAB}/empty.txt`;
  await writeText(file, "");
  const out = await grep({ path: file, pattern: "anything" });
  expect(out.matchCount).toBe(0);
  expect(out.matches).toEqual([]);
});

test("case-sensitive by default; ignoreCase flips exactly the specified matches (FR-006, SC-004)", async () => {
  const file = `${LAB}/case.txt`;
  await writeText(file, "Foo\nbar\nFOO baz\nfoo\n");
  const exact = await grep({ path: file, pattern: "FOO" });
  expect(exact.matchCount).toBe(1);
  expect(exact.matches.map((m) => m.line)).toEqual([3]);
  const folded = await grep({ path: file, pattern: "FOO", ignoreCase: true });
  expect(folded.matchCount).toBe(3);
  expect(folded.matches.map((m) => m.line)).toEqual([1, 3, 4]);
});

test("the pattern is a literal substring, never a regex (FR-003)", async () => {
  const file = `${LAB}/literal.txt`;
  await writeText(file, "a.b\naXb\n");
  const out = await grep({ path: file, pattern: "a.b" });
  expect(out.matchCount).toBe(1);
  expect(out.matches[0].line).toBe(1);
});

test("the pattern is matched as given — surrounding whitespace is not trimmed (edge case)", async () => {
  const file = `${LAB}/spaces.txt`;
  await writeText(file, "a x b\naxb\n");
  const out = await grep({ path: file, pattern: " x " });
  expect(out.matchCount).toBe(1);
  expect(out.matches[0].line).toBe(1);
});

test("a line with multiple occurrences is reported once (line-level matches)", async () => {
  const file = `${LAB}/multi.txt`;
  await writeText(file, "foo foo foo\nbar\n");
  const out = await grep({ path: file, pattern: "foo" });
  expect(out.matchCount).toBe(1);
  expect(out.matches).toHaveLength(1);
});

test("context: n returns surrounding lines, match identifiable, overlaps de-duplicated (FR-007, SC-005)", async () => {
  const file = `${LAB}/context.txt`;
  await writeText(file, ["l1", "l2", "l3", "needle A", "l5", "needle B", "l7", "l8"].join("\n"));

  // Two matches (lines 4 and 6) with 1 line of context: windows overlap on
  // line 5, which must appear exactly once.
  const out = await grep({ path: file, pattern: "needle", context: 1 });
  expect(out.matchCount).toBe(2);
  expect(out.matches.map((m) => m.line)).toEqual([3, 4, 5, 6, 7]);
  const matchLines = out.matches.filter((m) => !m.context).map((m) => m.line);
  const contextLines = out.matches.filter((m) => m.context).map((m) => m.line);
  expect(matchLines).toEqual([4, 6]);
  expect(contextLines).toEqual([3, 5, 7]);

  // Window clamped at the file edges.
  const wide = await grep({ path: file, pattern: "l1", context: 3 });
  expect(wide.matches.map((m) => m.line)).toEqual([1, 2, 3, 4]);

  // No flag (and a non-positive value) → zero extra lines.
  const bare = await grep({ path: file, pattern: "needle" });
  expect(bare.matches.map((m) => m.line)).toEqual([4, 6]);
  expect(bare.matches.every((m) => !m.context)).toBe(true);
  const zero = await grep({ path: file, pattern: "needle", context: -2 });
  expect(zero.matches.map((m) => m.line)).toEqual([4, 6]);
});

// ── FR-011: both truncation branches (SC-006 + "very long lines") ────────────

test("match count is capped with an explicit truncation note and withheld count (FR-011, SC-006)", async () => {
  const file = `${LAB}/dense.txt`;
  await writeText(file, Array.from({ length: 205 }, (_, i) => `needle ${i + 1}`).join("\n"));
  const out = await grep({ path: file, pattern: "needle" });
  expect(out.matchCount).toBe(205);
  expect(out.matches).toHaveLength(200);
  expect(out.matches[0].line).toBe(1);
  expect(out.matches[199].line).toBe(200);
  expect(String(out.truncated)).toContain("5");
});

test("a very long matching line is clipped with a marker; its line number stays correct (FR-011)", async () => {
  const file = `${LAB}/long.txt`;
  await writeText(file, `short\nfoo ${"x".repeat(500)}\n`);
  const out = await grep({ path: file, pattern: "foo" });
  expect(out.matchCount).toBe(1);
  const row = out.matches[0];
  expect(row.line).toBe(2);
  expect(row.text.length).toBeLessThanOrEqual(201);
  expect(row.text.endsWith("…")).toBe(true);
});

// ── US2: non-file targets fail loudly, never a silent [] (FR-008/009, SC-002) ─

test("a directory path is an explicit error pointing at file_search — not [] (FR-008)", async () => {
  await writeText(`${LAB}/inside.txt`, "content\n");
  const raw = await run("file_grep", { path: LAB, pattern: "content" });
  expect(raw).toMatch(/^Error: file_grep:/);
  expect(raw).toMatch(/directory/i);
  expect(raw).toContain("file_search");
});

test("a missing path is an explicit error — not [] (FR-008)", async () => {
  const raw = await run("file_grep", { path: `${LAB}/does-not-exist.txt`, pattern: "x" });
  expect(raw).toMatch(/^Error: file_grep:/);
  expect(raw).toMatch(/no file/i);
});

test("an unreadable file is an explicit error — not [] (FR-008)", async () => {
  const file = `${LAB}/locked.txt`;
  await writeText(file, "secret\n");
  chmodSync(hostPath(file), 0o000);
  try {
    const raw = await run("file_grep", { path: file, pattern: "secret" });
    expect(raw).toMatch(/^Error: file_grep:/);
    expect(raw).toMatch(/cannot read/i);
  } finally {
    chmodSync(hostPath(file), 0o600);
  }
});

test("a binary file named explicitly reports it cannot be decoded — no extension gating (FR-009)", async () => {
  // .md would pass file_search's SEARCHABLE_EXT whitelist — the point is that
  // file_grep decides by CONTENT, not extension, and reports loudly.
  const file = `${LAB}/blob.md`;
  await writeBuffer(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0x00]));
  const raw = await run("file_grep", { path: file, pattern: "PNG" });
  expect(raw).toMatch(/^Error: file_grep:/);
  expect(raw).toMatch(/binary|decode/i);
});

test("missing arguments degrade to the loud non-file error, not a silent success", async () => {
  const raw = await run("file_grep", {});
  expect(raw).toMatch(/^Error: file_grep:/);
});

// ── US3: discoverable as the single-file grep (FR-012/FR-013, SC-007) ────────

test("capability row: files group, both contexts, description says single file (FR-012)", async () => {
  const cap = listCapabilities().find((c) => c.id === "file_grep");
  expect(cap).toBeTruthy();
  expect(cap!.group).toBe("files");
  expect(cap!.context).toBe("both");
  expect(cap!.description.toLowerCase()).toContain("single");
  expect(cap!.description.toLowerCase()).toContain("file");
  // file_search keeps its directory-subtree role — distinguishable, not collapsed.
  const search = listCapabilities().find((c) => c.id === "file_search");
  expect(search!.description).toContain("subtree");
});

test("discovery routes single-file grep intent to file_grep and directory intent to file_search (FR-013, SC-007)", async () => {
  const FILES = listCapabilities().filter((c) => c.group === "files").map((c) => c.id);
  const lookup = (id: string): AssistantTool | undefined => {
    const cap = listCapabilities().find((c) => c.id === id);
    if (!cap) return undefined;
    return { name: id, description: cap.description, parameters: { type: "object" }, execution: "server" };
  };
  const findTools = discoveryTools(lookup).find_tools;
  setInRunAgent(RUN_ID, {
    id: "ephemeral-test",
    name: "Test",
    description: "test agent",
    type: "local",
    systemPrompt: "",
    tools: listCapabilities().map((c) => c.id),
    deferredTools: FILES,
  } as Agent);
  try {
    const ids = async (query: string) => {
      const raw = await findTools.execute!({ query }, ctx);
      const out = JSON.parse(typeof raw === "string" ? raw : raw.text) as { results?: { id: string }[] };
      return (out.results ?? []).map((r) => r.id);
    };

    // Single-file grep intent lands on file_grep first.
    const singleFile = await ids("grep this file");
    expect(singleFile[0]).toBe("file_grep");

    // The bare "grep" is no longer claimed by file_search alone (FR-013).
    const bareGrep = await ids("grep");
    expect(bareGrep[0]).toBe("file_grep");

    // Directory-subtree intent still lands on file_search, above file_grep.
    const dir = await ids("search for text across a whole directory subtree");
    const searchIdx = dir.indexOf("file_search");
    expect(searchIdx).toBeGreaterThanOrEqual(0);
    const grepIdx = dir.indexOf("file_grep");
    if (grepIdx !== -1) expect(searchIdx).toBeLessThan(grepIdx);
  } finally {
    clearInRunAgent(RUN_ID);
  }
});

// ── SC-008 / FR-014: the neighbouring FILES tools behave exactly as before ───
// (Also the contrast fixture: file_search pointed at a FILE still returns [] —
// that unchanged silence is exactly why file_grep exists.)

test("file_search still searches a subtree case-insensitively — and still returns [] for a file path", async () => {
  await writeText(`${LAB}/docs/a.md`, "Alpha\nthe NEEDLE here\n");
  await writeText(`${LAB}/docs/deep/b.md`, "needle again\n");
  await writeText(`${LAB}/docs/skip.bin`, "needle in binary-ext\n");

  const hits = JSON.parse(await run("file_search", { path: `${LAB}/docs`, query: "Needle" })) as GrepRow[];
  expect(hits.map((h) => `${h.path}:${h.line}`).sort()).toEqual([
    `${LAB}/docs/a.md:2`,
    `${LAB}/docs/deep/b.md:1`,
  ]);

  // Glob filter unchanged.
  const globbed = JSON.parse(await run("file_search", { path: LAB, query: "needle", glob: "docs/deep/*.md" })) as GrepRow[];
  expect(globbed.map((h) => h.path)).toEqual([`${LAB}/docs/deep/b.md`]);

  // The historical silent behaviour for a FILE path is unchanged (SC-008).
  const filePath = JSON.parse(await run("file_search", { path: `${LAB}/docs/a.md`, query: "needle" })) as GrepRow[];
  expect(filePath).toEqual([]);
});

test("file_search still skips unreadable files silently and caps at 200 results", async () => {
  const locked = `${LAB}/cap/locked.md`;
  await writeText(locked, "needle\n");
  chmodSync(hostPath(locked), 0o000);
  try {
    await writeText(`${LAB}/cap/dense.md`, Array.from({ length: 201 }, () => "needle").join("\n"));
    const hits = JSON.parse(await run("file_search", { path: `${LAB}/cap`, query: "needle" })) as GrepRow[];
    expect(hits).toHaveLength(200);
    expect(hits.every((h) => h.path === `${LAB}/cap/dense.md`)).toBe(true);
  } finally {
    chmodSync(hostPath(locked), 0o600);
  }
});

test("file_search / file_glob defaults on empty input are unchanged", async () => {
  await writeText(`${LAB}/root.md`, "x\n");
  // path defaults to "/", query to "" (matches every line of searchable files).
  const search = JSON.parse(await run("file_search", {})) as GrepRow[];
  expect(search.length).toBeGreaterThan(0);
  // pattern defaults to "**".
  const glob = JSON.parse(await run("file_glob", {})) as string[];
  expect(glob).toContain(`${LAB}/root.md`);
});

test("file_glob still matches globs relative to the search root", async () => {
  await writeText(`${LAB}/g/one.md`, "1");
  await writeText(`${LAB}/g/sub/two.md`, "2");
  await writeText(`${LAB}/g/file1.txt`, "t");

  const all = JSON.parse(await run("file_glob", { path: `${LAB}/g`, pattern: "**/*.md" })) as string[];
  expect(all.sort()).toEqual([`${LAB}/g/one.md`, `${LAB}/g/sub/two.md`]);

  const flat = JSON.parse(await run("file_glob", { path: `${LAB}/g`, pattern: "*.md" })) as string[];
  expect(flat).toEqual([`${LAB}/g/one.md`]);

  const q = JSON.parse(await run("file_glob", { path: `${LAB}/g`, pattern: "file?.txt" })) as string[];
  expect(q).toEqual([`${LAB}/g/file1.txt`]);
});

test("file_edit still edits, and still reports not-found / non-unique finds", async () => {
  const file = `${LAB}/edit.txt`;
  await writeText(file, "hello world\n");
  expect(await run("file_edit", { path: file, find: "world", replace: "bos" })).toContain("Edited");

  const longMiss = "m".repeat(80);
  const miss = await run("file_edit", { path: file, find: longMiss, replace: "x" });
  expect(miss).toMatch(/^Error: file_edit: Text not found/);
  expect(miss).toContain("…"); // shorten() still clips long snippets

  await writeText(file, "dup dup\n");
  expect(await run("file_edit", { path: file, find: "dup", replace: "x" })).toMatch(/matches 2 times/);
  expect(await run("file_edit", {})).toMatch(/^Error: file_edit:/);
});

test("file_patch still applies hunks in order and fails atomically", async () => {
  const file = `${LAB}/patch.txt`;
  await writeText(file, "one two\n");
  const ok = await run("file_patch", {
    path: file,
    hunks: [
      { find: "one", replace: "1" },
      { find: "1 two", replace: "1 2" },
    ],
  });
  expect(ok).toContain("2 hunks");

  expect(await run("file_patch", { path: file, hunks: [{ find: "absent", replace: "x" }] })).toMatch(/Hunk not found/);
  await writeText(file, "dup dup\n");
  expect(await run("file_patch", { path: file, hunks: [{ find: "dup", replace: "x" }] })).toMatch(/matches 2 times/);
  expect(await run("file_patch", {})).toMatch(/^Error: file_patch:/);
});

test("file_grep is registered read-only parallel-safe, like its siblings (FR-004)", async () => {
  const tools = fileTools();
  expect(tools.file_grep.parallelSafe).toBe(true);
  expect(tools.file_search.parallelSafe).toBe(true);
  expect(tools.file_glob.parallelSafe).toBe(true);
  // The mutating tools stay non-parallel — unchanged (SC-008).
  expect(tools.file_edit.parallelSafe).toBeUndefined();
  expect(tools.file_patch.parallelSafe).toBeUndefined();
});
