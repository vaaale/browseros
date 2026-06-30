import "server-only";
import { spawn } from "node:child_process";
import { connectMcpClient, extractText } from "@/lib/mcp/client";
import { getHarnessConfig } from "@/lib/devharness/harness-config";
import { supervisorEnabled, supervisorState, supervisorBegin, supervisorBuild } from "@/lib/devharness/supervisor";
import { stageAll } from "@/lib/system/git";
import type { McpServerConfig } from "@/lib/mcp/types";
import type { Agent, AgentRunResult } from "./types";

// Marks an error as "the harness couldn't run the agent" (vs. a task failure).
export const HARNESS_UNAVAILABLE = "harness-unavailable:";

type OnEvent = (e: { tool: string; input: unknown }) => void;

// Headless Claude can run for a while; cap below the delegate route's budget.
const CLI_TIMEOUT_MS = 590_000;

interface StreamEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  message?: { content?: { type?: string; name?: string; input?: unknown }[] };
}

// Run a Claude sub-agent by spawning Claude Code headless (`claude -p`) in the
// repo. Claude itself is the autonomous coding agent (its own Read/Edit/Write/
// Bash tools); we stream its tool_use events for the live UI and return its
// final result. Uses --dangerously-skip-permissions so it runs non-interactively.
function runClaudeCli(agent: Agent, task: string, cwd: string, onEvent?: OnEvent): Promise<AgentRunResult> {
  const base = { agent: agent.name, type: "claude" as const, task, steps: 0, toolCalls: [] as { tool: string; input: unknown }[] };
  onEvent?.({ tool: "Claude Code (headless)", input: { task } });

  const args = [
    "-p", task,
    "--append-system-prompt", agent.systemPrompt,
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ];
  if (agent.model) args.push("--model", agent.model);

  return new Promise<AgentRunResult>((resolve) => {
    const child = spawn("claude", args, { cwd, env: process.env });
    const toolCalls: { tool: string; input: unknown }[] = [];
    let steps = 0;
    let resultText = "";
    let isError = false;
    let stderr = "";
    let buf = "";
    let settled = false;

    const finish = (r: AgentRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      finish({ ...base, output: resultText, steps, toolCalls, error: `Claude CLI timed out after ${CLI_TIMEOUT_MS}ms.` });
    }, CLI_TIMEOUT_MS);

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
              onEvent?.(call);
            }
          }
        } else if (ev.type === "result") {
          if (typeof ev.result === "string") resultText = ev.result;
          isError = ev.is_error === true || (ev.subtype !== undefined && ev.subtype !== "success");
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => { stderr += c; });
    child.on("error", (e) =>
      finish({ ...base, output: "", error: `${HARNESS_UNAVAILABLE} failed to spawn claude (${e.message}). Is the Claude CLI installed and on PATH?` }),
    );
    child.on("close", async (code) => {
      if (isError || code !== 0) {
        finish({ ...base, output: resultText, steps, toolCalls, error: resultText || stderr.trim() || `claude exited with code ${code}.` });
        return;
      }
      // Deterministic backstop: stage everything the agent created/changed so
      // new files are never left untracked. Feature-branch + .gitignore make
      // `git add -A` safe; a staging error must never fail the task.
      let note = "";
      try {
        const r = await stageAll(cwd);
        if (r.staged > 0) note = `\n\n[harness] Staged ${r.staged} changed file(s)${r.created ? ` (${r.created} new)` : ""}.`;
      } catch {
        /* ignore staging errors */
      }
      finish({ ...base, output: resultText + note, steps, toolCalls });
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
}
interface OcEvent {
  type?: string; // "tool_use" | "step_start" | "step_finish" | "text" | "error"
  part?: OcPart;
  error?: unknown;
}

// Run a dev sub-agent by spawning OpenCode headless (`opencode run --format json`)
// in the repo. OpenCode itself is the autonomous coding agent (its own read/edit/
// write/bash tools); we stream its tool events for the live UI and accumulate its
// final text. OpenCode has no inline system-prompt flag, so — like the MCP path —
// we prepend the agent's prompt to the task message (avoids writing an opencode.json
// into the worktree, which the Supervisor would commit). `--dangerously-skip-
// permissions` runs it non-interactively, matching the Claude CLI path.
function runOpenCodeCli(agent: Agent, task: string, cwd: string, onEvent?: OnEvent): Promise<AgentRunResult> {
  const base = { agent: agent.name, type: "claude" as const, task, steps: 0, toolCalls: [] as { tool: string; input: unknown }[] };
  onEvent?.({ tool: "OpenCode (headless)", input: { task } });

  const args = [
    "run", `${agent.systemPrompt}\n\n## Task\n${task}`,
    "--format", "json",
    "--dangerously-skip-permissions",
  ];
  if (agent.model) args.push("--model", agent.model);

  return new Promise<AgentRunResult>((resolve) => {
    // stdio[0]="ignore" is REQUIRED: `opencode run` reads stdin and blocks on its
    // EOF when stdin is a non-TTY pipe (Node's spawn default), which would hang the
    // harness forever. Closing stdin lets it proceed immediately. (Claude Code's
    // `claude -p` doesn't read stdin, so runClaudeCli doesn't need this.)
    const child = spawn("opencode", args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
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

    const finalText = () => [...texts.values()].join("").trim();
    const finish = (r: AgentRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      finish({ ...base, output: finalText(), steps, toolCalls, error: `OpenCode CLI timed out after ${CLI_TIMEOUT_MS}ms.` });
    }, CLI_TIMEOUT_MS);

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
          onEvent?.(call);
        } else if (ev.type === "text" && part && part.synthetic !== true && part.ignored !== true) {
          const id = typeof part.id === "string" ? part.id : String(texts.size);
          if (typeof part.text === "string") texts.set(id, part.text);
        } else if (ev.type === "error") {
          errorText = typeof ev.error === "string" ? ev.error : JSON.stringify(ev.error);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => { stderr += c; });
    child.on("error", (e) =>
      finish({ ...base, output: "", error: `${HARNESS_UNAVAILABLE} failed to spawn opencode (${e.message}). Is the OpenCode CLI installed and on PATH?` }),
    );
    child.on("close", async (code) => {
      if (errorText || code !== 0) {
        finish({ ...base, output: finalText(), steps, toolCalls, error: errorText || stderr.trim() || `opencode exited with code ${code}.` });
        return;
      }
      // Same deterministic staging backstop as the Claude path.
      let note = "";
      try {
        const r = await stageAll(cwd);
        if (r.staged > 0) note = `\n\n[harness] Staged ${r.staged} changed file(s)${r.created ? ` (${r.created} new)` : ""}.`;
      } catch {
        /* ignore staging errors */
      }
      finish({ ...base, output: finalText() + note, steps, toolCalls });
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
async function runViaMcp(agent: Agent, task: string, server: McpServerConfig, onEvent?: OnEvent): Promise<AgentRunResult> {
  const requestedType = agent.subagentType || agent.id;
  const base = { agent: agent.name, type: "claude" as const, task, steps: 0, toolCalls: [] as { tool: string; input: unknown }[] };
  onEvent?.({ tool: `Claude:${requestedType}`, input: { task } });

  let client;
  try {
    client = await connectMcpClient(server);
  } catch (e) {
    return { ...base, output: "", error: `${HARNESS_UNAVAILABLE} ${(e as Error).message}` };
  }
  try {
    const tools = await client.listTools();
    if (!tools.tools.find((t) => t.name === "Agent")) {
      return { ...base, output: "", error: `${HARNESS_UNAVAILABLE} the harness exposes no 'Agent' tool.` };
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
        return { ...base, output: "", error: `${HARNESS_UNAVAILABLE} the harness has no registered agent types (${extractText(res)})` };
      }
    }
    const text = extractText(res);
    if (res.isError) {
      return { ...base, output: "", error: text || "The dev harness rejected the task.", steps: 1, toolCalls: [{ tool: "Agent", input: { subagent_type: requestedType } }] };
    }
    return { ...base, output: text, steps: 1, toolCalls: [{ tool: "Agent", input: { subagent_type: usedType } }] };
  } catch (e) {
    return { ...base, output: "", error: `${HARNESS_UNAVAILABLE} ${(e as Error).message}` };
  } finally {
    await client.close?.().catch(() => {});
  }
}

// Entry point: run a Claude sub-agent using whichever harness mode is configured.
export async function runClaudeAgent(
  agent: Agent,
  task: string,
  opts?: { onEvent?: OnEvent; contentOnly?: boolean; conversationId?: string; interactive?: boolean },
): Promise<AgentRunResult> {
  const harness = await getHarnessConfig();
  if (harness.mode === "mcp") return runViaMcp(agent, task, harness.server, opts?.onEvent);
  // Both CLI tools edit source in `cwd`; only the spawned binary + event parsing differ.
  const cliRun = harness.tool === "opencode" ? runOpenCodeCli : runClaudeCli;

  // Under the Supervisor (live version control), do the work in the isolated
  // `next` worktree and gate it behind a build; otherwise run in-place.
  // `contentOnly` tasks (e.g. generating an app's HTML — a GitFS content
  // operation, not a BOS-source edit) MUST NOT provision a code candidate: the
  // result is installed via installApp onto the app-candidate branch instead.
  let cwd = harness.cwd;
  let provisioned = false;
  let candidateBranch = "";
  if (supervisorEnabled() && !opts?.contentOnly && opts?.conversationId) {
    // Provision (or resume) the preview worktree for this conversation. The
    // Supervisor tracks previews by conversationId, so repeated work continues
    // on the SAME branch automatically — no external mapping needed.
    //   • interactive (a chat session): a currently-PREVIEWED branch wins ("improve
    //     the thing I'm looking at"), then the conversation's existing preview.
    //   • headless (workflow/integration): the conversation's existing preview is
    //     AUTHORITATIVE — never adopts a human's stray live preview.
    let resume: string | undefined;
    if (opts?.interactive) {
      const st = await supervisorState().catch(() => null);
      const serving = st && st.serving && typeof st.serving === "object" ? (st.serving as { conversationId?: string }).conversationId : undefined;
      // If THIS conversation is already being served as a preview, reuse it.
      if (serving === opts.conversationId) {
        const previewBranch = st && st.serving && typeof st.serving === "object" ? (st.serving as { branch?: string }).branch : undefined;
        resume = previewBranch;
      }
    }
    const begun = await supervisorBegin(opts.conversationId, resume);
    const wt = begun && typeof begun.worktree === "string" ? (begun.worktree as string) : "";
    if (wt) {
      cwd = wt;
      provisioned = true;
      candidateBranch = begun && typeof begun.branch === "string" ? (begun.branch as string) : "";
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
      return {
        agent: agent.name,
        type: "claude",
        task,
        output: "",
        steps: 0,
        toolCalls: [],
        error: `Could not provision an isolated preview worktree, so your change was NOT applied (refusing to edit the live version in place). Reason: ${reason}. Use Stop in the top bar to clear any stuck preview and try again; if it persists, restart the Supervisor.`,
      };
    }
  }
  const result = await cliRun(agent, task, cwd, opts?.onEvent);
  if (provisioned && !result.error && opts?.conversationId) {
    opts?.onEvent?.({ tool: "Supervisor: build + health-gate candidate", input: {} });
    const built = await supervisorBuild(opts.conversationId).catch(() => null);
    // Tell the caller the change is a CANDIDATE, not the live/active version — the
    // user must preview/promote it. Prevents the "fix is in place but the app still
    // doesn't work" confusion (the user was viewing active) and the bad workaround
    // of re-editing the main checkout in place (which then breaks Promote).
    const state = built && typeof built.state === "string" ? (built.state as string) : "";
    const brand = candidateBranch ? `\`${candidateBranch}\`` : "the next candidate";
    result.output =
      (result.output || "") +
      (state === "ready"
        ? `\n\n[candidate] Your changes are built as preview ${brand} — this is NOT yet the base version the user sees. To view it: top-bar **Base ▾** → **Preview**; then **Promote** to make it the base (or **Stop** to discard). Do NOT re-apply the change to the main checkout.`
        : `\n\n[candidate] Built preview ${brand}, but its health check did not pass (state: ${state || "unknown"}); it is not the base. Review before promoting.`);
  }
  return result;
}
