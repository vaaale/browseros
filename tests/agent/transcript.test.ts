import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  TranscriptionWriter,
  listAgentTranscripts,
  markTranscriptCaseId,
  readTranscript,
  readTranscriptEntries,
  transcriptJsonPathFor,
  transcriptPathFor,
  transcriptsDir,
} from "../../src/lib/agent/subagents/transcript";

// 031-self-healing scope-add, FR-029/FR-030 (design ADR-10). One markdown file
// per HEADLESS run, in the canonical data dir — never `/Documents/Chats`.
//
// The writer is the one piece of the scope-add that sits on a SHARED platform
// path (`runLocalHeadless` is called by the scheduler, Telegram, workflow steps
// and the delegate route), so these tests pin the two properties that make that
// safe: the documented file format, and a clean no-op when the config gate is
// off. Self-cleaning temp root — BOS_DATA_DIR *and* BOS_CANONICAL_DATA, because
// `dataDir()` is env-driven and resolved per call.

const TMP_ROOT = join(__dirname, ".tmp-transcript");
let counter = 0;

function useTranscriptRoot(label: string, enabled?: boolean) {
  const dir = join(TMP_ROOT, `${label}-${process.pid}-${++counter}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "config"), { recursive: true });
  const previousDataDir = process.env.BOS_DATA_DIR;
  const previousCanonical = process.env.BOS_CANONICAL_DATA;
  process.env.BOS_DATA_DIR = dir;
  process.env.BOS_CANONICAL_DATA = dir;
  if (enabled !== undefined) {
    writeFileSync(join(dir, "config", "agentRuns.json"), JSON.stringify({ "transcriptions.enabled": enabled }), "utf8");
  }
  return {
    dir,
    cleanup: () => {
      if (previousDataDir === undefined) delete process.env.BOS_DATA_DIR;
      else process.env.BOS_DATA_DIR = previousDataDir;
      if (previousCanonical === undefined) delete process.env.BOS_CANONICAL_DATA;
      else process.env.BOS_CANONICAL_DATA = previousCanonical;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The documented call sequence a local headless run produces. */
async function writeSampleRun(runId = "headless-build-studio-1728374122"): Promise<TranscriptionWriter> {
  const writer = new TranscriptionWriter();
  await writer.open("build-studio", runId, "implement a content-grep tool `file_grep` for BOS", {
    agentName: "Build Studio",
    kind: "local",
  });
  await writer.appendReasoning("The file tools live under src/components — start there.");
  await writer.appendAssistantText("I'll find where the existing file tooling lives.");
  await writer.appendToolCall("file_search", { dir: "src/components", query: "file_read" });
  await writer.appendToolResult("file_search", "12 matches — FilesTool.tsx:44 · FileTools.ts:128", true);
  return writer;
}

test.describe("headless-run transcription (FR-029/FR-030, ADR-10)", () => {
  test("a run's call sequence produces the documented markdown, in the canonical data dir", async () => {
    const root = useTranscriptRoot("format", true);
    try {
      const writer = await writeSampleRun();
      const path = join(root.dir, "agent-transcripts", "build-studio", "headless-build-studio-1728374122.md");
      expect(existsSync(path)).toBe(true);
      expect(transcriptPathFor("build-studio", "headless-build-studio-1728374122")).toBe(path);
      // NOT the VFS: the transcripts root is a sibling of it, never under
      // /Documents/Chats (FR-030).
      expect(transcriptsDir()).toBe(join(root.dir, "agent-transcripts"));
      expect(existsSync(join(root.dir, "Documents", "Chats"))).toBe(false);

      // In flight: frontmatter has no end marker, which is what makes the file
      // readable "up to the present" (FR-031).
      const inflight = readFileSync(path, "utf8");
      expect(inflight).toContain("agentId: build-studio");
      expect(inflight).toContain('agentName: "Build Studio"');
      expect(inflight).toContain("runId: headless-build-studio-1728374122");
      expect(inflight).toContain("kind: local");
      expect(inflight).toMatch(/startedAt: \d{4}-\d{2}-\d{2}T/);
      expect(inflight).not.toContain("endedAt:");
      expect(inflight).not.toContain("aborted:");

      // Body: the task input, then one timeline line per event.
      expect(inflight).toContain("## Task");
      expect(inflight).toContain("implement a content-grep tool `file_grep` for BOS");
      expect(inflight).toContain("## Timeline");
      expect(inflight).toContain("**reasoning**");
      expect(inflight).toContain("**assistant** I'll find where the existing file tooling lives.");
      expect(inflight).toContain('`file_search`({"dir":"src/components","query":"file_read"})');
      expect(inflight).toContain("↳ file_search → ok: 12 matches");
      expect(inflight).toMatch(/- \[\d\d:\d\d\.\d\]/);

      await writer.finalize();
      const done = readFileSync(path, "utf8");
      expect(done).toMatch(/endedAt: \d{4}-\d{2}-\d{2}T/);
      expect(done).not.toContain("aborted: true");
      // The body written before finalize is preserved verbatim.
      expect(done).toContain('`file_search`({"dir":"src/components","query":"file_read"})');
    } finally {
      root.cleanup();
    }
  });

  test("readTranscript derives in-flight / completed / aborted from the frontmatter", async () => {
    const root = useTranscriptRoot("status", true);
    try {
      const writer = await writeSampleRun("headless-a-1");
      const live = await readTranscript("headless-a-1");
      expect(live?.status).toBe("in-flight");
      expect(live?.agentId).toBe("build-studio");
      expect(live?.markdown).toContain("## Timeline");

      await writer.finalize();
      expect((await readTranscript("headless-a-1"))?.status).toBe("completed");

      const aborted = new TranscriptionWriter();
      await aborted.open("build-studio", "headless-a-2", "task two");
      await aborted.appendToolCall("file_search", { query: "x" });
      await aborted.finalize({ aborted: true });
      const read = await readTranscript("headless-a-2");
      expect(read?.status).toBe("aborted");
      // Partial: the tool call that DID execute is there, and the run is
      // truthfully marked as stopped rather than completed (ADR-11).
      expect(read?.markdown).toContain("`file_search`");
      expect(read?.markdown).toContain("aborted: true");
      expect(read?.markdown).toContain("run stopped");

      expect(await readTranscript("headless-does-not-exist")).toBeUndefined();
    } finally {
      root.cleanup();
    }
  });

  test("with transcriptions disabled the writer no-ops — no directory, no file, no throw", async () => {
    const root = useTranscriptRoot("disabled", false);
    try {
      const writer = await writeSampleRun("headless-off-1");
      await writer.finalize({ aborted: true });
      expect(writer.enabled).toBe(false);
      expect(existsSync(join(root.dir, "agent-transcripts"))).toBe(false);
      expect(await readTranscript("headless-off-1")).toBeUndefined();
      // markCaseId on a run that was never transcribed is a no-op too.
      expect(await markTranscriptCaseId("headless-off-1", "0141")).toBe(false);
    } finally {
      root.cleanup();
    }
  });

  test("transcription defaults to ON when nothing is configured", async () => {
    const root = useTranscriptRoot("default-on");
    try {
      const writer = await writeSampleRun("headless-default-1");
      expect(writer.enabled).toBe(true);
      await writer.finalize();
      expect(existsSync(join(root.dir, "agent-transcripts", "build-studio", "headless-default-1.md"))).toBe(true);
    } finally {
      root.cleanup();
    }
  });

  test("the owning consumer stamps caseId onto the frontmatter, once", async () => {
    const root = useTranscriptRoot("caseid", true);
    try {
      const writer = await writeSampleRun("headless-case-1");
      expect(await markTranscriptCaseId("headless-case-1", "0141")).toBe(true);
      let md = (await readTranscript("headless-case-1"))!.markdown;
      expect(md).toContain('caseId: "0141"');
      expect(await readTranscript("headless-case-1")).toMatchObject({ caseId: "0141" });

      // Idempotent: a redelivered run_started must not append a second line.
      expect(await markTranscriptCaseId("headless-case-1", "0141")).toBe(true);
      md = (await readTranscript("headless-case-1"))!.markdown;
      expect(md.match(/caseId:/g)).toHaveLength(1);

      // The stamp survives finalize (which rewrites the frontmatter).
      await writer.finalize();
      expect((await readTranscript("headless-case-1"))!.markdown).toContain('caseId: "0141"');
      expect(root.dir).toBeTruthy();
    } finally {
      root.cleanup();
    }
  });

  test("listAgentTranscripts lists an agent's runs, newest first, with status", async () => {
    const root = useTranscriptRoot("list", true);
    try {
      const first = new TranscriptionWriter();
      await first.open("conversation-reviewer", "headless-conversation-reviewer-1", "diagnose case 0001");
      await first.finalize();
      const second = new TranscriptionWriter();
      await second.open("conversation-reviewer", "headless-conversation-reviewer-2", "diagnose case 0002");

      const runs = await listAgentTranscripts("conversation-reviewer");
      expect(runs.map((r) => r.runId)).toEqual([
        "headless-conversation-reviewer-2",
        "headless-conversation-reviewer-1",
      ]);
      expect(runs[0].status).toBe("in-flight");
      expect(runs[1].status).toBe("completed");
      // An agent with no runs is an empty list, not a throw.
      expect(await listAgentTranscripts("nobody")).toEqual([]);
      expect(root.dir).toBeTruthy();
    } finally {
      root.cleanup();
    }
  });

  test("tool input and results are bounded so one run cannot write an unbounded file", async () => {
    const root = useTranscriptRoot("bounds", true);
    try {
      const writer = new TranscriptionWriter();
      await writer.open("build-studio", "headless-bounds-1", "x".repeat(10_000));
      await writer.appendToolCall("file_write", { path: "/a", content: "y".repeat(10_000) });
      await writer.appendToolResult("file_write", "z".repeat(10_000), false);
      await writer.appendAssistantText("w".repeat(10_000));
      await writer.finalize();
      const md = readFileSync(join(root.dir, "agent-transcripts", "build-studio", "headless-bounds-1.md"), "utf8");
      expect(md).toContain("…");
      expect(md).toContain("↳ file_write → error:");
      expect(md.length).toBeLessThan(8_000);
    } finally {
      root.cleanup();
    }
  });

  test("degenerate ids and inputs cannot escape the transcripts root or lose a line", async () => {
    const root = useTranscriptRoot("degenerate", true);
    try {
      // A runId with path separators must stay INSIDE the agent's directory.
      const writer = new TranscriptionWriter();
      await writer.open("", "../../escape", "task");
      expect(writer.filePath.startsWith(join(root.dir, "agent-transcripts"))).toBe(true);
      expect(writer.filePath).toContain("unknown");

      // An unserializable tool input degrades to its string form rather than
      // dropping the line.
      const circular: Record<string, unknown> = { name: "loop" };
      circular.self = circular;
      await writer.appendToolCall("weird_tool", circular);
      // Blank text is not a line at all.
      await writer.appendAssistantText("   ");
      await writer.appendReasoning("");
      await writer.finalize();
      const md = readFileSync(writer.filePath, "utf8");
      expect(md).toContain("`weird_tool`");
      expect(md).not.toContain("**assistant**");
      expect(md).not.toContain("**reasoning**");
      // finalize twice is a no-op, not a second footer.
      await writer.finalize();
      expect(readFileSync(writer.filePath, "utf8").match(/run ended/g)).toHaveLength(1);
    } finally {
      root.cleanup();
    }
  });

  test("a missing task, a missing tool input and an unnameable agent are all survivable", async () => {
    const root = useTranscriptRoot("missing-bits", true);
    try {
      const writer = new TranscriptionWriter();
      // An agent id made entirely of characters that cannot start a path
      // component still gets a directory, rather than writing to the root.
      await writer.open("...", "headless-nameless-1", undefined as unknown as string);
      expect(writer.filePath).toBe(join(root.dir, "agent-transcripts", "unknown", "headless-nameless-1.md"));
      await writer.appendToolCall("file_read", undefined);
      await writer.appendToolResult("file_read", undefined as unknown as string, true);
      await writer.finalize();
      const md = readFileSync(writer.filePath, "utf8");
      expect(md).toContain("`file_read`({})");
      expect(md).toContain("↳ file_read → ok:");
      expect(md).toContain("## Task");
    } finally {
      root.cleanup();
    }
  });

  test("a hand-edited or truncated transcript is read as best it can be, never thrown on", async () => {
    const root = useTranscriptRoot("malformed", true);
    try {
      const dir = join(root.dir, "agent-transcripts", "hand-written");
      mkdirSync(dir, { recursive: true });
      // No frontmatter at all: still readable, and in-flight by definition
      // (there is no end marker).
      writeFileSync(join(dir, "no-frontmatter.md"), "# just a body\n", "utf8");
      const plain = await readTranscript("no-frontmatter");
      expect(plain).toMatchObject({ status: "in-flight", agentId: "hand-written", runId: "no-frontmatter" });

      // An unterminated frontmatter block, a line with no colon, and a broken
      // quoted value — none of which may throw.
      writeFileSync(
        join(dir, "broken.md"),
        [
          "---",
          'agentName: "unclosed',
          "not a field line",
          ": leading colon",
          "endedAt: 2026-09-08T19:00:00.000Z",
          "---",
          "",
          "body",
          "",
        ].join("\n"),
        "utf8",
      );
      const broken = await readTranscript("broken");
      expect(broken?.status).toBe("completed");
      expect(broken?.agentName).toBe("unclosed");

      // Frontmatter that was never terminated (a crash mid-write) is treated
      // as body rather than parsed into nonsense.
      writeFileSync(join(dir, "unterminated.md"), ["---", "agentId: hand-written", "no closing marker"].join("\n"), "utf8");
      expect(await readTranscript("unterminated")).toMatchObject({ status: "in-flight", agentId: "hand-written" });

      // A stray FILE at the transcripts root is not an agent directory.
      writeFileSync(join(root.dir, "agent-transcripts", "stray.md"), "not an agent dir", "utf8");
      expect(await readTranscript("stray")).toBeUndefined();

      // A non-markdown file in the directory is ignored by the listing.
      writeFileSync(join(dir, "notes.txt"), "ignore me", "utf8");
      const runs = await listAgentTranscripts("hand-written");
      expect(runs.map((r) => r.runId).sort()).toEqual(["broken", "no-frontmatter", "unterminated"]);
    } finally {
      root.cleanup();
    }
  });

  test("stamping a caseId on an unreadable transcript reports failure instead of throwing", async () => {
    const root = useTranscriptRoot("caseid-broken", true);
    try {
      // A DIRECTORY where the transcript file should be: findable, unreadable.
      mkdirSync(join(root.dir, "agent-transcripts", "agent-x", "run-x.md"), { recursive: true });
      expect(await markTranscriptCaseId("run-x", "0141")).toBe(false);
      expect(await readTranscript("run-x")).toBeUndefined();
    } finally {
      root.cleanup();
    }
  });

  test("a child run records its parent, so a transcript says where it came from", async () => {
    const root = useTranscriptRoot("parentage", true);
    try {
      const writer = new TranscriptionWriter();
      await writer.open("developer", "claude-developer-1", "add file_grep", {
        kind: "claude",
        parentRunId: "headless-build-studio-1",
        caseId: "0141",
      });
      await writer.finalize({ endedAt: Date.parse("2026-09-08T19:31:40.000Z"), aborted: true });
      const doc = await readTranscript("claude-developer-1");
      expect(doc).toMatchObject({
        agentId: "developer",
        parentRunId: "headless-build-studio-1",
        caseId: "0141",
        status: "aborted",
        endedAt: "2026-09-08T19:31:40.000Z",
      });
      expect(doc?.markdown).toContain("kind: claude");
      expect(root.dir).toBeTruthy();
    } finally {
      root.cleanup();
    }
  });

  // ── Structured NDJSON companion (FR-037) ──────────────────────────────────
  // The markdown is the human-readable audit artifact; the .ndjson beside it is
  // the LOSSLESS record the Self-Heal pane renders as a conversation (FR-031):
  // one JSON object per line, same per-turn append cadence, same config gate.

  test("every append also lands one typed entry in the paired .ndjson, in order", async () => {
    const root = useTranscriptRoot("ndjson-format", true);
    try {
      const writer = await writeSampleRun("headless-ndjson-1");
      const jsonPath = join(root.dir, "agent-transcripts", "build-studio", "headless-ndjson-1.ndjson");
      expect(transcriptJsonPathFor("build-studio", "headless-ndjson-1")).toBe(jsonPath);
      expect(existsSync(jsonPath)).toBe(true);

      const lines = readFileSync(jsonPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines.map((e) => e.type)).toEqual(["task_input", "reasoning", "assistant_text", "tool_call", "tool_result"]);
      expect(lines[0].text).toContain("content-grep");
      // The tool call carries what ToolCardData needs: a callId, the name, the
      // REAL args object (not the markdown's flattened string), and "running"
      // until its result lands.
      expect(lines[3]).toMatchObject({
        name: "file_search",
        status: "running",
        args: { dir: "src/components", query: "file_read" },
      });
      expect(typeof lines[3].callId).toBe("string");
      expect(lines[3].callId).toBeTruthy();
      // The result pairs to its call even though writeSampleRun passes no
      // callId — the writer pairs a result to the last unmatched same-name call.
      expect(lines[4]).toMatchObject({ name: "file_search", status: "ok", callId: lines[3].callId });
      expect(lines[4].result).toContain("12 matches");

      // finalize appends NO ndjson entry: run status lives in the md frontmatter.
      await writer.finalize();
      expect(readFileSync(jsonPath, "utf8").trim().split("\n")).toHaveLength(5);
    } finally {
      root.cleanup();
    }
  });

  test("a caller-supplied callId is used verbatim, and a failed result is status error", async () => {
    const root = useTranscriptRoot("ndjson-callid", true);
    try {
      const writer = new TranscriptionWriter();
      await writer.open("build-studio", "headless-ndjson-2", "task");
      await writer.appendToolCall("dev_edit", { path: "/a" }, "call-abc-1");
      await writer.appendToolResult("dev_edit", "Error: no such file", false, "call-abc-1");
      await writer.finalize();

      const entries = (await readTranscriptEntries("headless-ndjson-2"))!;
      expect(entries).toMatchObject([
        { type: "task_input", text: "task" },
        { type: "tool_call", callId: "call-abc-1", name: "dev_edit", status: "running" },
        { type: "tool_result", callId: "call-abc-1", name: "dev_edit", status: "error", result: "Error: no such file" },
      ]);
    } finally {
      root.cleanup();
    }
  });

  test("assistant text keeps its newlines in the .ndjson (the markdown line flattens them)", async () => {
    const root = useTranscriptRoot("ndjson-newlines", true);
    try {
      const writer = new TranscriptionWriter();
      await writer.open("build-studio", "headless-ndjson-3", "task");
      await writer.appendAssistantText("First paragraph.\n\n- a bullet\n- another");
      await writer.finalize();

      const entries = (await readTranscriptEntries("headless-ndjson-3"))!;
      const text = entries.find((e) => e.type === "assistant_text");
      // Rendered through ChatMarkdown, so the structure must survive verbatim.
      expect(text).toMatchObject({ text: "First paragraph.\n\n- a bullet\n- another" });
      const md = readFileSync(transcriptPathFor("build-studio", "headless-ndjson-3"), "utf8");
      expect(md).toContain("**assistant** First paragraph. - a bullet - another");
    } finally {
      root.cleanup();
    }
  });

  test("readTranscriptEntries is undefined for a pre-FR-037 run (md only) and a missing run", async () => {
    const root = useTranscriptRoot("ndjson-fallback", true);
    try {
      // A hand-written run from before the companion existed: markdown reads
      // fine, entries are undefined — the API/pane falls back to the markdown.
      const dir = join(root.dir, "agent-transcripts", "old-agent");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "old-run.md"), "---\nagentId: old-agent\nrunId: old-run\n---\n\nbody\n", "utf8");
      expect((await readTranscript("old-run"))?.markdown).toContain("body");
      expect(await readTranscriptEntries("old-run")).toBeUndefined();
      expect(await readTranscriptEntries("never-ran")).toBeUndefined();

      // A torn tail line (crash mid-append) is skipped, not fatal.
      const writer = new TranscriptionWriter();
      await writer.open("build-studio", "headless-ndjson-4", "task");
      await writer.appendAssistantText("kept");
      await writer.finalize();
      const jsonPath = transcriptJsonPathFor("build-studio", "headless-ndjson-4");
      writeFileSync(jsonPath, readFileSync(jsonPath, "utf8") + '{"type":"assistant_te', "utf8");
      expect((await readTranscriptEntries("headless-ndjson-4"))!.map((e) => e.type)).toEqual([
        "task_input",
        "assistant_text",
      ]);
    } finally {
      root.cleanup();
    }
  });

  test("unserializable args and huge results are survivable and bounded in the .ndjson too", async () => {
    const root = useTranscriptRoot("ndjson-bounds", true);
    try {
      const writer = new TranscriptionWriter();
      await writer.open("build-studio", "headless-ndjson-5", "task");
      const circular: Record<string, unknown> = { name: "loop" };
      circular.self = circular;
      await writer.appendToolCall("weird_tool", circular);
      await writer.appendToolResult("weird_tool", "z".repeat(60_000), true);
      await writer.finalize();

      const entries = (await readTranscriptEntries("headless-ndjson-5"))!;
      const call = entries.find((e) => e.type === "tool_call");
      const result = entries.find((e) => e.type === "tool_result");
      // Circular input degrades to its string form rather than losing the entry.
      expect(call && "args" in call && typeof call.args === "string").toBe(true);
      expect(result && "result" in result && result.result.length <= 20_000).toBe(true);
      expect(result && "result" in result && result.result.endsWith("…")).toBe(true);
    } finally {
      root.cleanup();
    }
  });

  test("a write failure disables the writer instead of failing the run", async () => {
    const root = useTranscriptRoot("resilient", true);
    try {
      // The agent's transcript directory is occupied by a FILE, so the opening
      // mkdir cannot succeed. A transcript is a side-channel: the failure must
      // be swallowed (and the writer must stop trying), never propagated.
      mkdirSync(join(root.dir, "agent-transcripts"), { recursive: true });
      writeFileSync(join(root.dir, "agent-transcripts", "build-studio"), "in the way", "utf8");

      const writer = new TranscriptionWriter();
      await writer.open("build-studio", "headless-broken-1", "task");
      expect(writer.enabled).toBe(false);
      await writer.appendToolCall("file_search", { q: 1 });
      await writer.appendAssistantText("text");
      await writer.appendReasoning("thought");
      await writer.appendToolResult("file_search", "r", true);
      await writer.finalize({ aborted: true });
      expect(await readTranscript("headless-broken-1")).toBeUndefined();
    } finally {
      root.cleanup();
    }
  });
});
