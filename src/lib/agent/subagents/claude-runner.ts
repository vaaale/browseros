import "server-only";
import { spawn } from "node:child_process";
import { connectMcpClient, extractText } from "@/lib/mcp/client";
import { getHarnessConfig } from "@/lib/devharness/harness-config";
import { stageAll } from "@/lib/system/git";
import type { McpServerConfig } from "@/lib/mcp/types";
import type { SubAgent, SubAgentRunResult } from "./types";

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
function runClaudeCli(agent: SubAgent, task: string, cwd: string, onEvent?: OnEvent): Promise<SubAgentRunResult> {
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

  return new Promise<SubAgentRunResult>((resolve) => {
    const child = spawn("claude", args, { cwd, env: process.env });
    const toolCalls: { tool: string; input: unknown }[] = [];
    let steps = 0;
    let resultText = "";
    let isError = false;
    let stderr = "";
    let buf = "";
    let settled = false;

    const finish = (r: SubAgentRunResult) => {
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

function parseAvailableAgents(text: string): string[] {
  const m = text.match(/Available agents:\s*([\s\S]*)$/i);
  if (!m) return [];
  return m[1].split(/[,\n]/).map((s) => s.replace(/^[-*\s]+/, "").trim()).filter(Boolean);
}

// Run a Claude sub-agent via a Claude Code MCP harness (the Agent tool). Kept for
// remote/stdio harness setups; returns HARNESS_UNAVAILABLE if it can't spawn.
async function runViaMcp(agent: SubAgent, task: string, server: McpServerConfig, onEvent?: OnEvent): Promise<SubAgentRunResult> {
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
  agent: SubAgent,
  task: string,
  opts?: { onEvent?: OnEvent },
): Promise<SubAgentRunResult> {
  const harness = await getHarnessConfig();
  return harness.mode === "cli"
    ? runClaudeCli(agent, task, harness.cwd, opts?.onEvent)
    : runViaMcp(agent, task, harness.server, opts?.onEvent);
}
