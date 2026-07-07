import "server-only";
import { runToolLoop, type ToolEvent, type LlmTool } from "@/lib/agent/llm";
import { toolsFor, DEV_TOOLS, SPEC_TOOLS, DELEGATE_TO_DEVELOPER, makeSpecTools, makeDiscoveryTools, pickDeferredIds } from "./tools";
import { runClaudeAgent } from "./claude-runner";
import { getAgent } from "./store";
import { stageAll } from "@/lib/system/git";
import { runCommand, type RunLanguage } from "@/lib/system/run-command";
import { getLogContext } from "@/lib/logging/context";
import { deferredCapabilityIds } from "@/lib/agent/capabilities-registry";
import { getMaxFindResults } from "@/lib/config/registry";
import type { Agent, AgentRunResult } from "./types";

export type SubAgentEvent = ToolEvent;

const DEV_TOOL_IDS = Object.keys(DEV_TOOLS);
const SPEC_TOOL_IDS = Object.keys(SPEC_TOOLS);
// A local agent wielding repo-scoped tools is doing multi-step dev work; give it
// a much larger step budget than the default chat tool loop. Build Studio (spec
// tools + delegation) likewise runs multi-step pipelines.
const DEV_MAX_STEPS = 40;
// Build Studio -> Developer is one level of nesting; guard against more.
const MAX_DELEGATE_DEPTH = 2;

/** The delegate_to_developer tool. Built per-run so it can forward the parent's
 *  event stream (for the nested-agent UI), carry a depth guard, and inherit the
 *  active feature branch so nested dev work stays on the SAME branch as the run
 *  that spawned it. */
function makeDelegateTool(
  parentOnEvent: ((e: SubAgentEvent) => void) | undefined,
  depth: number,
  featureBranch?: string,
  interactive?: boolean,
): LlmTool {
  return {
    description:
      "Delegate an implementation/coding task to the Developer (Claude) sub-agent, which edits BOS source on a feature branch. Use this for `implement` — never write source yourself. Provide a complete task including the relevant spec/plan/tasks context and acceptance criteria.",
    parameters: {
      type: "object",
      properties: { task: { type: "string", description: "Full implementation task with context and acceptance criteria." } },
      required: ["task"],
    },
    execute: async (input) => {
      if (depth >= MAX_DELEGATE_DEPTH) return "Delegation depth limit reached; cannot nest another sub-agent.";
      const dev = await getAgent("developer");
      if (!dev) return "No 'developer' sub-agent is available to implement this.";
      const res = await runSubAgent(dev, String(input.task ?? ""), { onEvent: parentOnEvent, depth: depth + 1, featureBranch, interactive });
      if (res.error) return `Developer error: ${res.error}`;
      return res.output || "(the developer returned no output)";
    },
  };
}

// run_command needs a per-run (browser-session, agent) sandbox key, so it is
// injected per delegated run rather than living in the static tool table.
function makeRunCommandTool(agentId: string): LlmTool {
  const sessionId = getLogContext().sessionId || "server";
  const sessionKey = `${sessionId}:${agentId}`;
  return {
    description:
      "Run a command in a sandboxed environment (Settings → Command Execution; off by default). language: 'bash' (default), 'python' (ipython -c), or 'node' (node -e). " +
      "WORKSPACE: /workspace IS a folder in the user's file system (visible in the Files app). Files you create under /workspace are ALREADY SAVED and visible — do NOT copy/move them elsewhere or use file_write to 'transfer' them. Only /workspace (and /tmp) exist in the sandbox; folders like /Documents are NOT mounted. " +
      "Common tools are preinstalled (python + python-pptx/markitdown/Pillow, node + pptxgenjs, LibreOffice, poppler) — avoid npm/pip install (no network). " +
      "To run a SKILL's bundled scripts, pass `skill` = its id — the skill's files are staged into /workspace so its SKILL.md relative paths (e.g. `python scripts/office/unpack.py`) work. Returns merged stdout/stderr, exit code, and duration.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        language: { type: "string", enum: ["bash", "python", "node"] },
        skill: { type: "string", description: "Optional skill id to stage into the working dir first." },
        timeoutMs: { type: "number" },
      },
      required: ["command"],
    },
    execute: async (input) => {
      const lang = ["bash", "python", "node"].includes(input.language as string) ? (input.language as RunLanguage) : "bash";
      const r = await runCommand({
        command: String(input.command ?? ""),
        language: lang,
        skill: typeof input.skill === "string" && input.skill ? input.skill : undefined,
        timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : undefined,
        sessionKey,
      });
      return JSON.stringify(r);
    },
  };
}

async function runLocal(
  agent: Agent,
  task: string,
  opts?: { onEvent?: (e: SubAgentEvent) => void; depth?: number; featureBranch?: string; interactive?: boolean },
): Promise<AgentRunResult> {
  const depth = opts?.depth ?? 0;
  const ids = agent.tools ?? [];
  const isDev = ids.some((id) => DEV_TOOL_IDS.includes(id));
  const isExtended = isDev || ids.includes(DELEGATE_TO_DEVELOPER) || ids.some((id) => SPEC_TOOL_IDS.includes(id));

  const tools = { ...(await toolsFor(agent.tools)) };
  if (ids.includes(DELEGATE_TO_DEVELOPER)) {
    tools[DELEGATE_TO_DEVELOPER] = makeDelegateTool(opts?.onEvent, depth, opts?.featureBranch, opts?.interactive);
  }
  if (ids.includes("run_command")) {
    tools["run_command"] = makeRunCommandTool(agent.id);
  }
  // Bind spec tools to the run's active feature branch so reads/writes target that
  // branch's worktree spec store (020) — specs land on the same branch as the code.
  const specIds = ids.filter((id) => SPEC_TOOL_IDS.includes(id));
  if (specIds.length) {
    const boundSpec = makeSpecTools(opts?.featureBranch);
    for (const id of specIds) tools[id] = boundSpec[id];
  }

  // Deferred-tool discovery (025). Compute the per-agent effective deferred set
  // (registry defaults ∪ this agent's own `deferredTools`) and wire the two
  // discovery tools + the loop's hidden/revealed sets so an agent can find and
  // then call deferred tools mid-loop.
  const registryDeferred = deferredCapabilityIds();
  const agentDeferred = new Set(agent.deferredTools ?? []);
  const effectiveDeferred = new Set<string>([...registryDeferred, ...agentDeferred]);
  const hiddenIds = pickDeferredIds(tools, effectiveDeferred);
  const revealed = new Set<string>();
  const maxResults = await getMaxFindResults();
  Object.assign(
    tools,
    makeDiscoveryTools({
      allow: agent.tools ?? [],
      tools,
      effectiveDeferred,
      reveal: (revealIds) => revealIds.forEach((rid) => revealed.add(rid)),
      maxResults,
    }),
  );

  const result = await runToolLoop({
    system: agent.systemPrompt,
    prompt: task,
    tools,
    maxSteps: isExtended ? DEV_MAX_STEPS : undefined,
    onEvent: opts?.onEvent,
    hiddenIds,
    revealed,
  });
  let output = result.text;
  if (isDev) {
    // Same deterministic staging backstop as the Claude harness: ensure files a
    // dev agent created are staged, not left untracked.
    try {
      const r = await stageAll();
      if (r.staged > 0) output += `\n\n[harness] Staged ${r.staged} changed file(s)${r.created ? ` (${r.created} new)` : ""}.`;
    } catch {
      /* ignore staging errors */
    }
  }
  return { agent: agent.name, type: "local", task, output, steps: result.steps, toolCalls: result.toolCalls };
}

/** Run a sub-agent. Claude agents run as Claude Code (headless CLI or MCP harness)
 *  so development is actually done by Claude; local agents run via the configured
 *  provider's tool loop. onEvent streams tool calls live as they happen. */
export async function runSubAgent(
  agent: Agent,
  task: string,
  opts?: {
    onEvent?: (e: SubAgentEvent) => void;
    contentOnly?: boolean;
    depth?: number;
    // Server-resolved branch for source edits. It is deliberately not part of the
    // public LLM tool schema; callers resolve it from Assistant/workflow state.
    featureBranch?: string;
    interactive?: boolean;
  },
): Promise<AgentRunResult> {
  if (agent.type === "claude") {
    // Development must be done by Claude — no local-provider fallback here.
    return runClaudeAgent(agent, task, opts);
  }
  try {
    return await runLocal(agent, task, opts);
  } catch (e) {
    return { agent: agent.name, type: "local", task, output: "", steps: 0, toolCalls: [], error: (e as Error).message };
  }
}
