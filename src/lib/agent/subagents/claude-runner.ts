import "server-only";
import { spawn } from "node:child_process";
import { statSync, mkdirSync } from "node:fs";
import path from "node:path";
import { connectMcpClient, extractText } from "@/lib/mcp/client";
import { getHarnessConfig, harnessCredentialEnv, type HarnessConfig } from "@/lib/devharness/harness-config";
import { getOpenCodeProviderEnv } from "@/lib/devharness/generate-config";
import { supervisorEnabled, supervisorBegin, supervisorBuild } from "@/lib/devharness/supervisor";
import { stageAll } from "@/lib/system/git";
import { dataDir } from "@/os/data-dir";
import { logger } from "@/lib/logging/server-logger";
import { TranscriptionWriter } from "./transcript";
import { registerRun, unregisterRun } from "./run-registry";
import type { McpServerConfig } from "@/lib/mcp/types";
import type { Agent, AgentRunResult, AgentRunUsage, SubAgentEvent } from "./types";

const COMPONENT = "subagents.claude-runner";

const COMPONENT = "subagents.claude-runner";

// Marks an error as "the harness couldn't run the agent" (vs. a task failure).
export const HARNESS_UNAVAILABLE = "harness-unavailable:";

type OnEvent = (e: SubAgentEvent) => void;

/** How long a SIGTERM'd CLI child is given to exit before it is SIGKILLed
 *  (031-self-healing scope-add, ADR-11/R12): a harness wedged in a long tool
 *  call can outlive a SIGTERM, and a Stop that leaves the process editing the
 *  worktree would be a lie. Only the ABORT path escalates — the existing
 *  timeout path keeps its bare SIGTERM (out of scope). */
const SIGKILL_GRACE_MS = 5_000;

/** Per-run identity, threaded from `runClaudeAgent` (which generates it BEFORE
 *  its early-return refusal sites) into whichever transport actually runs, so
 *  every AgentRunResult can name its run and every spawned child can be
 *  registered for abort. */
interface RunContext {
  runId: string;
  parentRunId?: string;
}

/** Register a spawned CLI child so `abortHeadlessRun(runId)` can stop it —
 *  including as the CHILD of a delegating run, which is what makes a self-heal
 *  Stop reach a nested Developer process (ADR-11's cascade). */
function registerChild(ctx: RunContext, agent: Agent, kill: (signal: NodeJS.Signals) => void): void {
  registerRun(ctx.runId, {
    agentId: agent.id,
    ...(ctx.parentRunId ? { parentRunId: ctx.parentRunId } : {}),
    abort: () => {
      kill("SIGTERM");
      const timer = setTimeout(() => kill("SIGKILL"), SIGKILL_GRACE_MS);
      // The process may well be gone long before the grace expires; the timer
      // must not hold the event loop open until then.
      timer.unref?.();
    },
  });
}

/** The leading `run_started` event (ADR-12) — how a caller learns this run's id
 *  while it is still in flight, which is what Stop and case→run linkage need. */
function emitRunStarted(ctx: RunContext, agent: Agent, onEvent?: OnEvent): void {
  onEvent?.({
    type: "run_started",
    runId: ctx.runId,
    agentId: agent.id,
    startedAt: new Date().toISOString(),
    ...(ctx.parentRunId ? { parentRunId: ctx.parentRunId } : {}),
  });
}

/** Open this run's transcript (ADR-10). Config-gated inside the writer, so a
 *  disabled setting makes every append below a no-op. */
async function openCliTranscript(ctx: RunContext, agent: Agent, task: string): Promise<TranscriptionWriter> {
  const transcript = new TranscriptionWriter();
  await transcript.open(agent.id, ctx.runId, task, {
    agentName: agent.name,
    kind: "claude",
    ...(ctx.parentRunId ? { parentRunId: ctx.parentRunId } : {}),
  });
  return transcript;
}

/** Close a CLI run's transcript with what the harness finally reported. The
 *  harness streams tool calls but reports its text once, at the end, so the
 *  final text is appended here rather than per turn. */
async function endCliTranscript(transcript: TranscriptionWriter, result: AgentRunResult, aborted: boolean): Promise<void> {
  if (result.error) await transcript.appendToolResult(result.agent, result.error, false);
  if (result.output) await transcript.appendAssistantText(result.output);
  await transcript.finalize({ aborted });
}

// Applies the Dev Harness's model override (Settings → Dev Harness) on top of
// the agent's own `model`, if it has one. Only meaningful for the CLI
// transports — the MCP path drives a remote Agent tool with its own model
// handling, so a harness model override wouldn't apply there.
function withHarnessModel(agent: Agent, harness: HarnessConfig): Agent {
  if (harness.mode !== "cli" || !harness.model) return agent;
  return { ...agent, model: harness.model };
}

function envForCwd(cwd: string): NodeJS.ProcessEnv {
  // harnessCredentialEnv() sets HOME to the harness home when the user has
  // provisioned Claude/OpenCode credentials, so the headless CLIs authenticate
  // without an interactive login (essential in container deployments).
  return { ...process.env, PWD: cwd, ...harnessCredentialEnv() };
}

/**
 * `supervisorBuild`, retried — this call is what makes `buildAndStart`'s
 * commit step actually run, which is the ONE thing standing between an
 * agent's edit and it being durably on the branch (see the "always build"
 * comment at the call site below). `supervisorBuild` itself never throws —
 * it swallows a network/connection failure into `null` (devharness/
 * supervisor.ts's `call()`) — so a single unretried call here previously
 * meant: the Supervisor being briefly unreachable (mid-restart, a network
 * blip) silently skipped the commit, with no retry and no distinct signal
 * to the caller that this happened. Retries a few times with backoff before
 * giving up, since a transient Supervisor hiccup is exactly the case a retry
 * fixes; logs every attempt so a persistent failure is diagnosable instead
 * of just showing up as "state: unknown" to the user.
 */
async function buildCandidateWithRetry(branch: string, attempts = 3): Promise<Record<string, unknown> | null> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const built = await supervisorBuild(branch);
    if (built) return built;
    logger().warn(COMPONENT, `supervisorBuild(${branch}) attempt ${attempt}/${attempts} did not reach the Supervisor`, {});
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
  logger().error(COMPONENT, `supervisorBuild(${branch}) failed after ${attempts} attempts — the candidate's commit may not have completed`, {});
  return null;
}

/** Where a `contentOnly` run works: its own directory under `dataDir()`, never
 *  BOS's checkout. Exported so the "outside the source tree" property is pinned
 *  rather than assumed — that property is the whole point, and when it was
 *  absent the symptom appeared somewhere else entirely (a blocked build of an
 *  unrelated preview branch).
 *
 *  Created here, not by the CLI: spawning with a cwd that does not exist fails
 *  with a bare ENOENT that names nothing useful. Kept after the run — it holds
 *  whatever the agent produced, which is usually the item being installed. */
export function contentOnlyWorkDir(runId: string): string {
  const dir = path.join(dataDir(), "harness", "content", runId.replace(/[^a-zA-Z0-9._-]/g, "-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Exported for tests — the two predicates below decide whether a `contentOnly`
 *  delegation runs at all, and a wrong verdict is silent (see
 *  `referencesBosOwnDevDoc`), so they are pinned directly. */
export function isStandaloneContentTask(task: string): boolean {
  const t = task.toLowerCase();
  return [
    "standalone app",
    "iframe app",
    "single static file",
    "self-contained index.html",
    "self contained index.html",
    "output only a single self-contained",
    "output only a single self contained",
    "write a bos app project",
    "staging directory",
    "staging dir",
    "installapp",
    "buildapp",
  ].some((needle) => t.includes(needle));
}

/**
 * The `docs/dev/` veto needs more than a substring match, because that literal
 * is no longer exclusively BOS's own documentation. An installed marketplace
 * ITEM carries its docs INSIDE the item, in the same two-audience shape
 * (`docs/usage/<Name>/`, `docs/dev/<Name>/` relative to the staging directory —
 * see the Build Studio skill's `target-marketplace-item.md`), so a legitimate
 * contentOnly task now has every reason to say it.
 *
 * What must still be refused is a task pointing at a page BOS ITSELF ships: a
 * contentOnly run executes in the live source checkout (it deliberately skips
 * the Supervisor worktree every real source edit goes through), so an edit
 * there lands off-branch and unversioned.
 *
 * Ask the filesystem instead of the string: `docs/dev/architecture-overview.md`
 * resolves to a real file in the source repo and is refused; an item's
 * `docs/dev/Widgets/architecture.md` does not exist and passes. A bare
 * `docs/dev/` with no page named is not matched at all — naming no file means
 * there is no BOS page to damage, and the allow-list still has to match for the
 * run to proceed regardless.
 *
 * This mattered more than a plain false positive: the blunt match killed the
 * WHOLE delegation (app, service and docs alike), and the refusal text coaches
 * the agent to strip the offending wording — so the retry succeeded and shipped
 * an item with no documentation, silently.
 */
function referencesBosOwnDevDoc(task: string, sourceRoot: string): boolean {
  // Case-sensitive, against the ORIGINAL text: BOS's own pages are lowercase
  // kebab-case, whereas an item's folder is its display name (`Widgets`).
  for (const [match] of task.matchAll(/docs\/dev\/[\w./-]*\.md/g)) {
    // Traversal out of docs/dev/ is never a legitimate item-docs path.
    if (match.includes("..")) return true;
    if (statSync(path.join(sourceRoot, match), { throwIfNoEntry: false })?.isFile()) return true;
  }
  return false;
}

/** WHICH phrase made this look like BOS-source work, or null. The refusal used
 *  to name the whole category and let the agent guess which words to remove; a
 *  live session guessed wrong, rewrote the task twice, and burned three turns
 *  at the `implement` step. Quoting the match turns that into one edit. */
export function bosSourceTrigger(task: string, sourceRoot: string): string | null {
  const t = task.toLowerCase();
  const phrase = [
    "browseros source",
    "browseros's own source",
    "bos source",
    "bos's own source",
    "built-in app",
    "built in app",
    "settings tab",
    "api route",
    "server logic",
    "gitlab issue",
    "issue #",
  ].find((needle) => t.includes(needle));
  if (phrase) return `"${phrase}"`;
  const srcPath = t.match(/\bsrc\/(app|apps|components|lib|os|store)\//);
  if (srcPath) return `a path into BOS's source ("${srcPath[0]}")`;
  if (referencesBosOwnDevDoc(task, sourceRoot)) return "a page BOS itself ships under docs/dev/";
  return null;
}

export function isBosSourceTask(task: string, sourceRoot: string): boolean {
  return bosSourceTrigger(task, sourceRoot) !== null;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  /** Claude Code's stream-json `result` line reports the run's token usage. */
  usage?: unknown;
  message?: { content?: { type?: string; id?: string; name?: string; input?: unknown }[]; usage?: unknown };
}

// ── Token usage (031-self-healing ADR-5) ────────────────────────────────────
//
// Both harnesses report usage in their own shape, on their own final event, and
// neither is guaranteed to report at all (an older CLI, a proxied provider).
// Absent usage stays `undefined` — a harness run that reported nothing must not
// look free.

/** Normalize a harness usage object into AgentRunUsage. Accepts Claude Code's
 *  `{input_tokens, output_tokens, cache_read_input_tokens, …}` and OpenCode's
 *  `{input, output, cache:{read,write}}` / `{tokens:{…}}` shapes. */
function parseHarnessUsage(raw: unknown): AgentRunUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = u[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  const inputTokens = num("input_tokens", "input", "prompt_tokens");
  const outputTokens = num("output_tokens", "output", "completion_tokens");
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const cache = u.cache && typeof u.cache === "object" ? (u.cache as Record<string, unknown>) : undefined;
  const cacheNum = (key: string, ...flat: string[]): number | undefined => {
    const nested = cache?.[key];
    if (typeof nested === "number" && Number.isFinite(nested)) return nested;
    return num(...flat);
  };
  const cacheRead = cacheNum("read", "cache_read_input_tokens");
  const cacheWrite = cacheNum("write", "cache_creation_input_tokens");
  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  const declaredTotal = num("total_tokens", "total");
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: declaredTotal ?? input + output,
    ...(cacheRead ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

/** OpenCode reports usage on a `step_finish`/final part rather than a top-level
 *  usage field — accept either placement. */
function parseOpenCodeUsage(ev: { part?: { tokens?: unknown; usage?: unknown }; tokens?: unknown; usage?: unknown }): AgentRunUsage | undefined {
  return (
    parseHarnessUsage(ev.part?.tokens) ??
    parseHarnessUsage(ev.part?.usage) ??
    parseHarnessUsage(ev.tokens) ??
    parseHarnessUsage(ev.usage)
  );
}

/** Exported for tests/self-heal/usage-surface.test.ts — the harness stream
 *  shapes are exactly the thing a CLI upgrade silently changes. */
export const _harnessUsageInternals = { parseHarnessUsage, parseOpenCodeUsage };

// Run a Claude sub-agent by spawning Claude Code headless (`claude -p`) in the
// repo. Claude itself is the autonomous coding agent (its own Read/Edit/Write/
// Bash tools); we stream its tool_use events for the live UI and return its
// final result. Uses --dangerously-skip-permissions so it runs non-interactively.
async function runClaudeCli(
  agent: Agent,
  task: string,
  cwd: string,
  timeoutMs: number,
  ctx: RunContext,
  onEvent?: OnEvent,
): Promise<AgentRunResult> {
  const base = { agent: agent.name, type: "claude" as const, task, steps: 0, toolCalls: [] as { tool: string; input: unknown }[], runId: ctx.runId };
  emitRunStarted(ctx, agent, onEvent);
  onEvent?.({ tool: "Claude Code (headless)", input: { task } });
  const transcript = await openCliTranscript(ctx, agent, task);

  const args = [
    "-p", task,
    "--append-system-prompt", agent.systemPrompt,
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ];
  if (agent.model) args.push("--model", agent.model);

  return new Promise<AgentRunResult>((resolve) => {
    const child = spawn("claude", args, { cwd, env: envForCwd(cwd) });
    const toolCalls: { tool: string; input: unknown }[] = [];
    let steps = 0;
    let resultText = "";
    let isError = false;
    let stderr = "";
    let buf = "";
    let settled = false;
    let usage: AgentRunUsage | undefined;
    let aborted = false;

    // ADR-11: the spawned child is the abort handle for this run. Killing it
    // lets the run's OWN close handler write the partial transcript and settle,
    // so an abort takes the same end path a normal exit does.
    registerChild(ctx, agent, (signal) => {
      aborted = true;
      try { child.kill(signal); } catch { /* already gone */ }
    });

    const finish = (r: AgentRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unregisterRun(ctx.runId);
      void endCliTranscript(transcript, r, aborted).then(() => resolve(r));
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      finish({ ...base, output: resultText, steps, toolCalls, endedReason: "error", error: `Claude CLI timed out after ${timeoutMs}ms.`, ...(usage ? { usage } : {}) });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        let ev: StreamEvent;
        try { ev = JSON.parse(s) as StreamEvent; } catch { continue; }
        if (ev.type === "assistant" && ev.message?.content) {
          for (const block of ev.message.content) {
            if (block.type === "tool_use") {
              steps++;
              const call = { tool: block.name ?? "tool", input: block.input };
              toolCalls.push(call);
              void transcript.appendToolCall(call.tool, call.input, block.id);
              onEvent?.(call);
            }
          }
        } else if (ev.type === "result") {
          if (typeof ev.result === "string") resultText = ev.result;
          isError = ev.is_error === true || (ev.subtype !== undefined && ev.subtype !== "success");
          usage = parseHarnessUsage(ev.usage) ?? usage;
        } else if (ev.type === "assistant" && ev.message?.usage) {
          // Fallback for CLI versions that report per-message rather than on
          // the result line: the LAST report wins (it is cumulative).
          usage = parseHarnessUsage(ev.message.usage) ?? usage;
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => { stderr += c; });
    child.on("error", (e) =>
      finish({ ...base, output: "", endedReason: "error", error: `${HARNESS_UNAVAILABLE} failed to spawn claude (${e.message}). Is the Claude CLI installed and on PATH?` }),
    );
    child.on("close", async (code) => {
      // Deterministic backstop: stage everything the agent created/changed so
      // new files are never left untracked. Runs unconditionally — even on a
      // non-zero exit the agent may have written partial work that supervisorBuild
      // should commit and preserve. Feature-branch + .gitignore make `git add -A`
      // safe; a staging error must never fail the task.
      let note = "";
      try {
        const r = await stageAll(cwd);
        if (r.staged > 0) note = `\n\n[harness] Staged ${r.staged} changed file(s)${r.created ? ` (${r.created} new)` : ""}.`;
      } catch (e) {
        // Non-fatal: buildAndStart's own `git add -A` (Supervisor-side, on
        // the next call) restages everything anyway — but a failure here is
        // still worth knowing about, not silently dropped.
        logger().warn(COMPONENT, `staging changes in ${cwd} failed: ${(e as Error)?.message ?? e}`, {});
      }
      if (isError || code !== 0) {
        finish({
          ...base,
          output: resultText + note,
          steps,
          toolCalls,
          error: resultText || stderr.trim() || `claude exited with code ${code}.`,
          endedReason: aborted ? "cancelled" : "error",
          ...(aborted ? { aborted: true } : {}),
          ...(usage ? { usage } : {}),
        });
        return;
      }
      finish({ ...base, output: resultText + note, steps, toolCalls, endedReason: "completed", ...(usage ? { usage } : {}) });
    });
  });
}

interface OcPart {
  type?: string;
  id?: string;
  callID?: string;
  tool?: string;
  state?: { input?: unknown; status?: string };
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
  /** Token accounting, when this part carries it (031-self-healing ADR-5). */
  tokens?: unknown;
  usage?: unknown;
}
interface OcEvent {
  type?: string; // "tool_use" | "step_start" | "step_finish" | "text" | "error"
  part?: OcPart;
  error?: unknown;
  tokens?: unknown;
  usage?: unknown;
}

// Run a dev sub-agent by spawning OpenCode headless (`opencode run --format json`)
// in the repo. OpenCode itself is the autonomous coding agent (its own read/edit/
// write/bash tools); we stream its tool events for the live UI and accumulate its
// final text. OpenCode has no inline system-prompt flag, so — like the MCP path —
// we prepend the agent's prompt to the task message (avoids writing an opencode.json
// into the worktree, which the Supervisor would commit). `--auto` runs it
// non-interactively, matching the Claude CLI path.
async function runOpenCodeCli(
  agent: Agent,
  task: string,
  cwd: string,
  timeoutMs: number,
  ctx: RunContext,
  onEvent?: OnEvent,
): Promise<AgentRunResult> {
  const base = { agent: agent.name, type: "claude" as const, task, steps: 0, toolCalls: [] as { tool: string; input: unknown }[], runId: ctx.runId };
  emitRunStarted(ctx, agent, onEvent);
  onEvent?.({ tool: "OpenCode (headless)", input: { task } });
  const transcript = await openCliTranscript(ctx, agent, task);

  const args = [
    "run", `${agent.systemPrompt}\n\n## Task\n${task}`,
    "--format", "json",
    "--dir", cwd,
    "--auto",
  ];
  if (agent.model) args.push("--model", agent.model);

  // Some OpenCode auth methods (Vertex, Azure) have no opencode.json config
  // surface at all — their required parameters are environment-variable-only
  // per OpenCode's own docs — so they're injected here rather than generated
  // into a file (029-settings-dev-harness US5).
  const providerEnv = await getOpenCodeProviderEnv();

  return new Promise<AgentRunResult>((resolve) => {
    // stdio[0]="ignore" is REQUIRED: `opencode run` reads stdin and blocks on its
    // EOF when stdin is a non-TTY pipe (Node's spawn default), which would hang the
    // harness forever. Closing stdin lets it proceed immediately. (Claude Code's
    // `claude -p` doesn't read stdin, so runClaudeCli doesn't need this.)
    const child = spawn("opencode", args, { cwd, env: { ...envForCwd(cwd), ...providerEnv }, stdio: ["ignore", "pipe", "pipe"] });
    const toolCalls: { tool: string; input: unknown }[] = [];
    const seenCalls = new Set<string>();
    // Text parts arrive as cumulative updates keyed by part id; last-write-wins per
    // id, joined in order, yields the final assistant message.
    const texts = new Map<string, string>();
    let steps = 0;
    let errorText = "";
    let stderr = "";
    let buf = "";
    let settled = false;
    let usage: AgentRunUsage | undefined;
    let aborted = false;

    // Same abort handle as the Claude path (ADR-11).
    registerChild(ctx, agent, (signal) => {
      aborted = true;
      try { child.kill(signal); } catch { /* already gone */ }
    });

    const finalText = () => [...texts.values()].join("").trim();
    const finish = (r: AgentRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unregisterRun(ctx.runId);
      void endCliTranscript(transcript, r, aborted).then(() => resolve(r));
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      finish({ ...base, output: finalText(), steps, toolCalls, endedReason: "error", error: `OpenCode CLI timed out after ${timeoutMs}ms.`, ...(usage ? { usage } : {}) });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        let ev: OcEvent;
        try { ev = JSON.parse(s) as OcEvent; } catch { continue; }
        const part = ev.part;
        if (ev.type === "tool_use" && part) {
          // A tool part is emitted on each state change; count/stream each callID once.
          const cid = typeof part.callID === "string" ? part.callID : "";
          if (cid && seenCalls.has(cid)) continue;
          if (cid) seenCalls.add(cid);
          steps++;
          const call = { tool: part.tool ?? "tool", input: part.state?.input ?? {} };
          toolCalls.push(call);
          void transcript.appendToolCall(call.tool, call.input, cid || undefined);
          onEvent?.(call);
        } else if (ev.type === "text" && part && part.synthetic !== true && part.ignored !== true) {
          const id = typeof part.id === "string" ? part.id : String(texts.size);
          if (typeof part.text === "string") texts.set(id, part.text);
        } else if (ev.type === "error") {
          errorText = typeof ev.error === "string" ? ev.error : JSON.stringify(ev.error);
        }
        // Usage can ride any event (OpenCode puts it on step_finish); the last
        // report wins, matching its cumulative semantics.
        usage = parseOpenCodeUsage(ev) ?? usage;
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => { stderr += c; });
    child.on("error", (e) =>
      finish({ ...base, output: "", endedReason: "error", error: `${HARNESS_UNAVAILABLE} failed to spawn opencode (${e.message}). Is the OpenCode CLI installed and on PATH?` }),
    );
    child.on("close", async (code) => {
      // Same unconditional staging backstop as the Claude path.
      let note = "";
      try {
        const r = await stageAll(cwd);
        if (r.staged > 0) note = `\n\n[harness] Staged ${r.staged} changed file(s)${r.created ? ` (${r.created} new)` : ""}.`;
      } catch (e) {
        // Non-fatal: buildAndStart's own `git add -A` (Supervisor-side, on
        // the next call) restages everything anyway — but a failure here is
        // still worth knowing about, not silently dropped.
        logger().warn(COMPONENT, `staging changes in ${cwd} failed: ${(e as Error)?.message ?? e}`, {});
      }
      if (errorText || code !== 0) {
        finish({
          ...base,
          output: finalText() + note,
          steps,
          toolCalls,
          error: errorText || stderr.trim() || `opencode exited with code ${code}.`,
          endedReason: aborted ? "cancelled" : "error",
          ...(aborted ? { aborted: true } : {}),
          ...(usage ? { usage } : {}),
        });
        return;
      }
      finish({ ...base, output: finalText() + note, steps, toolCalls, endedReason: "completed", ...(usage ? { usage } : {}) });
    });
  });
}

function parseAvailableAgents(text: string): string[] {
  const m = text.match(/Available agents:\s*([\s\S]*)$/i);
  if (!m) return [];
  return m[1].split(/[,\n]/).map((s) => s.replace(/^[-*\s]+/, "").trim()).filter(Boolean);
}

// Run a Claude sub-agent via a Claude Code MCP harness (the Agent tool). Kept for
// remote/stdio harness setups; returns HARNESS_UNAVAILABLE if it can't spawn.
async function runViaMcp(
  agent: Agent,
  task: string,
  server: McpServerConfig,
  ctx: RunContext,
  onEvent?: OnEvent,
): Promise<AgentRunResult> {
  const requestedType = agent.subagentType || agent.id;
  const base = { agent: agent.name, type: "claude" as const, task, steps: 0, toolCalls: [] as { tool: string; input: unknown }[], runId: ctx.runId };
  emitRunStarted(ctx, agent, onEvent);
  onEvent?.({ tool: `Claude:${requestedType}`, input: { task } });
  // A single round-trip Agent call, not a streamed tool loop, so its transcript
  // is minimal by nature: the task, the one call, and the result (ADR-10's
  // noted boundary for this rare remote setup).
  const transcript = await openCliTranscript(ctx, agent, task);
  const done = async (r: AgentRunResult): Promise<AgentRunResult> => {
    await endCliTranscript(transcript, r, false);
    return r;
  };

  let client;
  try {
    client = await connectMcpClient(server);
  } catch (e) {
    return done({ ...base, output: "", endedReason: "error", error: `${HARNESS_UNAVAILABLE} ${(e as Error).message}` });
  }
  try {
    const tools = await client.listTools();
    if (!tools.tools.find((t) => t.name === "Agent")) {
      return done({ ...base, output: "", endedReason: "error", error: `${HARNESS_UNAVAILABLE} the harness exposes no 'Agent' tool.` });
    }
    const prompt = `${agent.systemPrompt}\n\n## Task\n${task}`;
    const description = `BrowserOS: ${agent.name}`.slice(0, 60);
    const callAgent = (subagentType?: string) =>
      client!.callTool(
        { name: "Agent", arguments: { description, prompt, ...(subagentType ? { subagent_type: subagentType } : {}) } },
        undefined,
        { timeout: 280_000, resetTimeoutOnProgress: true },
      );

    let res = await callAgent(requestedType);
    let usedType = requestedType;
    if (res.isError) {
      const available = parseAvailableAgents(extractText(res));
      const fallback = available.find((a) => a === "developer") ?? available[0];
      if (fallback && fallback !== requestedType) {
        res = await callAgent(fallback);
        usedType = fallback;
      } else if (available.length === 0) {
        return done({ ...base, output: "", endedReason: "error", error: `${HARNESS_UNAVAILABLE} the harness has no registered agent types (${extractText(res)})` });
      }
    }
    const text = extractText(res);
    if (res.isError) {
      return done({ ...base, output: "", endedReason: "error", error: text || "The dev harness rejected the task.", steps: 1, toolCalls: [{ tool: "Agent", input: { subagent_type: requestedType } }] });
    }
    return done({ ...base, output: text, steps: 1, endedReason: "completed", toolCalls: [{ tool: "Agent", input: { subagent_type: usedType } }] });
  } catch (e) {
    return done({ ...base, output: "", endedReason: "error", error: `${HARNESS_UNAVAILABLE} ${(e as Error).message}` });
  } finally {
    await client.close?.().catch((e) => logger().warn(COMPONENT, `closing MCP client failed: ${(e as Error)?.message ?? e}`, {}));
  }
}

// Entry point: run a Claude sub-agent using whichever harness mode is configured.
export async function runClaudeAgent(
  agent: Agent,
  task: string,
  opts?: { onEvent?: OnEvent; contentOnly?: boolean; featureBranch?: string; interactive?: boolean; runId?: string; parentRunId?: string },
): Promise<AgentRunResult> {
  const harness = await getHarnessConfig();
  // Generated HERE, before every early-return refusal below (S2): `runId` is
  // required on AgentRunResult, and a refusal is still a call a caller may want
  // to correlate. It is also what the transport registers for abort and names
  // the transcript after.
  const ctx: RunContext = {
    runId: opts?.runId ?? `claude-${agent.id}-${Date.now()}`,
    ...(opts?.parentRunId ? { parentRunId: opts.parentRunId } : {}),
  };
  const refusal = (error: string): AgentRunResult => ({
    agent: agent.name,
    type: "claude",
    task,
    output: "",
    steps: 0,
    toolCalls: [],
    runId: ctx.runId,
    endedReason: "error",
    error,
  });

  if (opts?.contentOnly) {
    // The tree a contentOnly run is FORBIDDEN to write into — under the
    // Supervisor that is the main repo, not this process's cwd (which may be a
    // preview worktree). `mcp` mode drives a remote Agent tool whose working
    // directory is the server's, so fall back to the source root we know about.
    // Used only to JUDGE the task below; the run itself no longer stands here.
    const sourceRoot = harness.mode === "cli" ? harness.cwd : harness.server.cwd || process.cwd();
    const sourceTrigger = bosSourceTrigger(task, sourceRoot);
    if (!isStandaloneContentTask(task) || sourceTrigger) {
      return refusal(
        // WHICH of the two conditions failed, first and in its own sentence.
        // Both used to produce the same paragraph, so an agent whose task was
        // merely missing a trigger phrase read the BOS-source half and started
        // deleting wording that was never the problem.
        (sourceTrigger
          ? `Refusing contentOnly developer harness run: the task names ${sourceTrigger}, which reads as work on BrowserOS's OWN source. Remove that reference (the item's design/spec already carries its module layout) and retry. `
          : "Refusing contentOnly developer harness run: the task does not say it is standalone item content, so this could not be told apart from a BOS-source change. Say so explicitly — include a phrase like \"staging directory\" or \"write a bos app project\" — and retry. ") +
        "`contentOnly:true` is only for standalone app content generation; BrowserOS source analysis or implementation must run through the Supervisor feature-branch worktree with contentOnly omitted/false. " +
          "If this IS standalone content (e.g. a marketplace item), do not switch to dev_delegate — that forces an unrelated BOS-source feature branch onto a plain item build. Instead rephrase this SAME task: include a trigger phrase like \"staging directory\"/\"write a bos app project\", and remove any spec-path references or BOS-source-sounding wording (\"api route\", \"server logic\", \"src/...\", etc.) — see the Build Studio skill's target-marketplace-item.md, Step 1, for the exact rule. " +
          "One thing NOT to strip: an item's own documentation. `docs/usage/<Name>/…` and `docs/dev/<Name>/…` inside the staging directory are part of the item and never trigger this refusal — only a path naming a page BOS itself ships (e.g. docs/dev/architecture-overview.md) does, and editing those is a separate dev_delegate.",
      );
    }
    // A run that may not touch BOS's source must not STAND IN BOS's source
    // tree. It used to run with cwd = the live checkout, so every relative path
    // it wrote landed there: a real session left `mockup-dashboard.png`,
    // `mockup-dash2.png` and a modified `package-lock.json` in the repo root,
    // and the damage did not surface until the NEXT preview build, which the
    // Supervisor's safety gate blocked with "developer harness edited the live
    // checkout" — hours after the run that did it, and about a different branch.
    //
    // Its own directory instead: nothing to damage, stray output is inert and
    // inspectable, and a staging path the agent reports is a real path anyone
    // can act on. Under `dataDir()`, which is gitignored and per-user.
    const work = contentOnlyWorkDir(ctx.runId);
    const runAgent: Agent = {
      ...agent,
      systemPrompt:
        agent.systemPrompt +
        `\n\n---\nWORKSPACE (runtime, authoritative): Your working directory is ${work}. ` +
        `It is an EMPTY scratch directory, not BrowserOS's source checkout — this task is standalone content generation, ` +
        `so nothing of BOS's is here to read or change, and nothing you write here affects the running system. ` +
        `Build the app under this directory (e.g. ${work}/app) and report the ABSOLUTE path of what you produced, ` +
        `so the caller can install it. Never write outside it.`,
    };
    if (harness.mode === "mcp") {
      return runViaMcp(runAgent, task, { ...harness.server, cwd: work, env: { ...(harness.server.env ?? {}), PWD: work } }, ctx, opts?.onEvent);
    }
    const cliRun = harness.tool === "opencode" ? runOpenCodeCli : runClaudeCli;
    return cliRun(withHarnessModel(runAgent, harness), task, work, harness.timeoutMs, ctx, opts?.onEvent);
  }

  // Source edits must never run in the live checkout. The Supervisor is the only
  // supported source-edit path because it deterministically provisions an isolated
  // feature-branch worktree and builds it as a candidate before promotion.
  if (!supervisorEnabled()) {
    return refusal(
      "Refusing to run the developer harness against the live checkout. Source edits require the Supervisor so BOS can provision an isolated feature-branch worktree. Start BOS with `npm run supervisor` and retry.",
    );
  }
  if (!opts?.featureBranch) {
    return refusal(
      "Refusing to run the developer harness without an active feature branch. Call the requestFeatureBranch action to set one up (it prompts the user for a name), then retry the delegation.",
    );
  }
  if (harness.mode === "mcp" && harness.server.transport !== "stdio") {
    return refusal(
      "Refusing to run a remote MCP developer harness for source edits. BOS cannot force a remote harness to use the Supervisor's preview worktree. Use Claude CLI, OpenCode CLI, or MCP stdio under the Supervisor.",
    );
  }

  let cwd = "";
  const candidateBranch = opts.featureBranch;

  // Provision (or resume) the preview worktree for the active feature branch.
  // The branch is resolved server-side from Assistant/workflow state and is not
  // an LLM-callable argument.
  const begun = await supervisorBegin(candidateBranch);
  const wt = begun && typeof begun.worktree === "string" ? (begun.worktree as string) : "";
  if (wt) {
    cwd = wt;
    opts?.onEvent?.({ tool: "Supervisor: provision preview worktree", input: { worktree: wt, branch: candidateBranch } });
  } else {
    // Provisioning the isolated worktree FAILED. We must NOT fall back to editing
    // the live checkout in place: under the Supervisor the running version is
    // served from it (in dev, `next dev` hot-recompiles it), so in-place edits can
    // crash the running BOS and pollute the base checkout (breaking Promote). Fail
    // loudly with the reason instead of silently doing damage. (specs/005, 017)
    const reason =
      begun && typeof begun.error === "string" && begun.error
        ? begun.error
        : "the Supervisor did not return a preview worktree";
    opts?.onEvent?.({ tool: "Supervisor: provision FAILED — change not applied", input: { reason } });
    return refusal(
      `Could not provision an isolated preview worktree, so your change was NOT applied (refusing to edit the live version in place). Reason: ${reason}. Use Stop in the top bar to clear any stuck preview and try again; if it persists, restart the Supervisor.`,
    );
  }

  // Inject the workspace boundary at RUNTIME, where we know the exact worktree path.
  // This cannot live in the agent's seeded systemPrompt: seed prompt edits only reach
  // fresh installs (existing installs keep their persisted data/agents/<id>/AGENT.md).
  // Injecting here reaches every harness path (all use agent.systemPrompt) on every run,
  // and can name the real absolute worktree path — closing the "Developer reads specs
  // from the main checkout on a stale branch" bug (git worktree internals leak the main
  // checkout path via .git / git-common-dir / `git worktree list`).
  const workspaceNote =
    `\n\n---\nWORKSPACE (runtime, authoritative): Your working directory is ${cwd}. ` +
    `All spec stores are mounted here at ${cwd}/specs/<storeId>/ (e.g. specs/bos-system-specs/, specs/user-specs/), ` +
    `checked out on THIS feature's branch — they hold the authoritative, up-to-date specs for this task. ` +
    `Read specs with paths RELATIVE to your working directory (e.g. specs/bos-system-specs/scheduler/spec.md). ` +
    `NEVER search /home for spec directories and NEVER read specs via an absolute path into another checkout ` +
    `(e.g. anything under a different repo path such as .../browseros/specs/...) — those are different git branches and will give you STALE content. ` +
    `Stay inside ${cwd} for all reads and edits.`;
  const runAgent: Agent = { ...agent, systemPrompt: agent.systemPrompt + workspaceNote };

  const result =
    harness.mode === "mcp"
      ? await runViaMcp(runAgent, task, { ...harness.server, cwd, env: { ...(harness.server.env ?? {}), PWD: cwd } }, ctx, opts?.onEvent)
      : await (harness.tool === "opencode" ? runOpenCodeCli : runClaudeCli)(withHarnessModel(runAgent, harness), task, cwd, harness.timeoutMs, ctx, opts?.onEvent);

  // Always build when a candidate branch exists — even if the agent reported an
  // error, any staged partial work gets committed and health-gated so it is
  // inspectable and recoverable rather than silently left uncommitted. Only skip
  // when the worktree was never provisioned (no branch).
  if (candidateBranch) {
    opts?.onEvent?.({ tool: "Supervisor: build + health-gate candidate", input: {} });
    const built = await buildCandidateWithRetry(candidateBranch);
    // Tell the caller the change is a CANDIDATE, not the live/active version — the
    // user must preview/promote it. Prevents the "fix is in place but the app still
    // doesn't work" confusion (the user was viewing active) and the bad workaround
    // of re-editing the main checkout in place (which then breaks Promote).
    const state = built && typeof built.state === "string" ? (built.state as string) : "";
    const brand = `\`${candidateBranch}\``;
    result.output =
      (result.output || "") +
      (state === "ready"
        ? `\n\n[candidate] Your changes are built as preview ${brand} — this is NOT yet the base version the user sees. To view it: top-bar **Base ▾** → **Preview**; then **Promote** to make it the base (or **Stop** to discard). Do NOT re-apply the change to the main checkout.`
        : built === null
          ? `\n\n[candidate] Could not reach the Supervisor to build preview ${brand} after several attempts — your changes may NOT be committed yet. Retry this delegation before assuming the change is safe; check Settings → Versions or the Supervisor logs if it keeps failing.`
          : `\n\n[candidate] Built preview ${brand}, but its health check did not pass (state: ${state || "unknown"}); it is not the base. Review before promoting.`);
  }
  return result;
}
