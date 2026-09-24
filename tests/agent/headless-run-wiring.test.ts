import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { Agent, SubAgentEvent } from "../../src/lib/agent/subagents/types";

// 031-self-healing scope-add — the platform wiring inside `runLocalHeadless`
// itself (FR-029/FR-031/FR-032, design ADR-10/11/12), driven through the REAL
// runner rather than a stub.
//
// The other two suites test the pieces in isolation (feed the writer events,
// register mock abort handles). This one is the join: an actual headless run,
// with the actual agent loop, asserting that the run emits `run_started` first,
// writes its own transcript from its own event stream, is abortable by runId,
// and reports how it ended. `runLocalHeadless` is a SHARED path — the scheduler,
// the Telegram router, workflow steps and the delegate route all go through it —
// so "the wiring works AND changes nothing else" is the property under test.
//
// Hermetic: the model seam is the scripted-turn provider (a task that starts
// with `@@e2e ` plus BOS_E2E_SCRIPTED=1), so no provider is ever reached.

process.env.BOS_E2E_SCRIPTED = "1";

const TMP_ROOT = join(__dirname, ".tmp-headless");
let counter = 0;

function useRunRoot(label: string, transcriptions?: boolean) {
  const dir = join(TMP_ROOT, `${label}-${process.pid}-${++counter}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "config"), { recursive: true });
  const previousDataDir = process.env.BOS_DATA_DIR;
  const previousCanonical = process.env.BOS_CANONICAL_DATA;
  process.env.BOS_DATA_DIR = dir;
  process.env.BOS_CANONICAL_DATA = dir;
  if (transcriptions !== undefined) {
    writeFileSync(
      join(dir, "config", "agentRuns.json"),
      JSON.stringify({ "transcriptions.enabled": transcriptions }),
      "utf8",
    );
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

const agent: Agent = {
  id: "wiring-probe",
  name: "Wiring Probe",
  description: "d",
  type: "local",
  systemPrompt: "You are a test probe.",
  ephemeral: true,
  tools: ["file_write"],
};

const script = (turns: unknown[]) => `@@e2e ${JSON.stringify({ turns })}`;

function firstRunStarted(events: SubAgentEvent[]) {
  const first = events[0];
  return first && "type" in first && first.type === "run_started" ? first : undefined;
}

test.describe("runLocalHeadless: transcript + abort wiring", () => {
  test("a real run announces itself, transcribes itself, and reports how it ended", async () => {
    const root = useRunRoot("real-run", true);
    try {
      const { runSubAgent } = await import("../../src/lib/agent/subagents/runner");
      const { readTranscript } = await import("../../src/lib/agent/subagents/transcript");
      const { hasRun } = await import("../../src/lib/agent/subagents/run-registry");

      const events: SubAgentEvent[] = [];
      const result = await runSubAgent(
        agent,
        script([
          { text: "writing the file", tools: [{ name: "file_write", args: { path: "/Documents/probe.txt", content: "hi" } }] },
          { text: "all done" },
        ]),
        { onEvent: (e) => events.push(e) },
      );

      // ADR-12: `run_started` is the FIRST thing a caller sees, which is what
      // makes a fire-and-forget run stoppable at all.
      const started = firstRunStarted(events);
      expect(started).toBeTruthy();
      expect(started!.runId).toBe(result.runId);
      expect(started!.agentId).toBe("wiring-probe");
      expect(Number.isNaN(Date.parse(started!.startedAt))).toBe(false);

      // M1: the loop's end reason is surfaced, and a clean run is not "aborted".
      expect(result.endedReason).toBe("completed");
      expect(result.aborted).toBeUndefined();
      expect(result.output).toBe("all done");
      expect(result.runId).toContain("wiring-probe");

      // ADR-10: the run wrote its own transcript, from its own event stream.
      const doc = await readTranscript(result.runId);
      expect(doc?.status).toBe("completed");
      expect(doc?.agentId).toBe("wiring-probe");
      expect(doc?.markdown).toContain("## Task");
      expect(doc?.markdown).toContain("@@e2e");
      expect(doc?.markdown).toContain("`file_write`");
      expect(doc?.markdown).toContain("↳ file_write → ok:");
      expect(doc?.markdown).toContain("**assistant** all done");
      expect(doc?.markdown).toContain("**run ended** — completed");

      // ADR-11: the registry self-cleans in the run's `finally`.
      expect(hasRun(result.runId)).toBe(false);
    } finally {
      root.cleanup();
    }
  });

  test("abortHeadlessRun stops a live run, which reports it and leaves a partial transcript", async () => {
    const root = useRunRoot("abort-run", true);
    try {
      const { runSubAgent } = await import("../../src/lib/agent/subagents/runner");
      const { readTranscript } = await import("../../src/lib/agent/subagents/transcript");
      const { abortHeadlessRun, hasRun } = await import("../../src/lib/agent/subagents/run-registry");

      let runId = "";
      const pending = runSubAgent(
        agent,
        script([
          { text: "writing first", tools: [{ name: "file_write", args: { path: "/Documents/before-stop.txt", content: "hi" } }] },
          // A slow second turn: streamed in small chunks with a delay between
          // them, which is where the abort lands.
          { text: "x".repeat(60), deltas: 60, delayMs: 300 },
        ]),
        {
          onEvent: (e) => {
            if ("type" in e && e.type === "run_started") runId = e.runId;
          },
        },
      );

      // The runId arrives on the leading event, long before the result.
      for (let i = 0; i < 200 && !runId; i++) await new Promise((r) => setTimeout(r, 25));
      expect(runId).toBeTruthy();
      // Wait until the run is actually mid-flight (its first tool call done),
      // so the abort has something to interrupt.
      for (let i = 0; i < 200; i++) {
        if (existsSync(join(root.dir, "vfs", "Documents", "before-stop.txt"))) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(hasRun(runId)).toBe(true);
      expect(abortHeadlessRun(runId)).toBe(true);

      const result = await pending;
      // ADR-11 + M1: the run reports the cancellation, so a caller that did not
      // initiate it can still tell.
      expect(result.endedReason).toBe("cancelled");
      expect(result.aborted).toBe(true);
      expect(result.runId).toBe(runId);
      expect(result.error).toBeUndefined();

      // The partial transcript is written by the SAME end path a clean run
      // uses — everything that executed, and an honest `aborted` mark.
      const doc = await readTranscript(runId);
      expect(doc?.status).toBe("aborted");
      expect(doc?.markdown).toContain("`file_write`");
      expect(doc?.markdown).toContain("aborted: true");
      expect(doc?.markdown).toContain("run stopped");
      expect(hasRun(runId)).toBe(false);
    } finally {
      root.cleanup();
    }
  });

  test("with transcription off the run is byte-for-byte unaffected and writes nothing", async () => {
    const root = useRunRoot("no-transcript", false);
    try {
      const { runSubAgent } = await import("../../src/lib/agent/subagents/runner");
      const events: SubAgentEvent[] = [];
      const result = await runSubAgent(agent, script([{ text: "nothing to see" }]), {
        onEvent: (e) => events.push(e),
      });

      expect(result.output).toBe("nothing to see");
      expect(result.endedReason).toBe("completed");
      expect(result.runId).toBeTruthy();
      // The run still ANNOUNCES itself (that is the control plane, not the
      // transcript) — only the file is skipped.
      expect(firstRunStarted(events)).toBeTruthy();
      expect(existsSync(join(root.dir, "agent-transcripts"))).toBe(false);
    } finally {
      root.cleanup();
    }
  });

  test("a nested run records its parent, so an abort can cascade to it (ADR-11)", async () => {
    const root = useRunRoot("nested-run", true);
    try {
      const { runSubAgent } = await import("../../src/lib/agent/subagents/runner");
      const { readTranscript } = await import("../../src/lib/agent/subagents/transcript");
      const result = await runSubAgent(agent, script([{ text: "child work" }]), {
        parentRunId: "headless-build-studio-parent",
      });
      // The parentage is durable (the transcript says where the run came from)
      // as well as in-memory (the registry, tested in run-registry.test.ts).
      expect((await readTranscript(result.runId))?.parentRunId).toBe("headless-build-studio-parent");
      expect(root.dir).toBeTruthy();
    } finally {
      root.cleanup();
    }
  });

  test("a caller-supplied runId is honoured, so it can name the run before it starts", async () => {
    const root = useRunRoot("given-runid", true);
    try {
      const { runSubAgent } = await import("../../src/lib/agent/subagents/runner");
      const result = await runSubAgent(agent, script([{ text: "named run" }]), { runId: "headless-caller-named-1" });
      expect(result.runId).toBe("headless-caller-named-1");
      expect(existsSync(join(root.dir, "agent-transcripts", "wiring-probe", "headless-caller-named-1.md"))).toBe(true);
      expect(readFileSync(join(root.dir, "agent-transcripts", "wiring-probe", "headless-caller-named-1.md"), "utf8")).toContain(
        "runId: headless-caller-named-1",
      );
    } finally {
      root.cleanup();
    }
  });
});
