"use client";

import { useCopilotAction } from "@/components/agent/gated-action";
import { encodeNested } from "@/lib/agent/nested-events";
import { startDelegation, pushDelegationEvent, finishDelegation } from "@/lib/agent/subagent-events";

type Choice = "once" | "session" | "local";

interface DelegateResult {
  agent: string;
  type: string;
  steps: number;
  output?: string;
  error?: string;
  toolCalls?: { tool: string; input?: unknown }[];
}

// Sub-agent delegation: list/create agents, delegate (existing or ephemeral),
// and an elicitation card to approve a Claude agent for a non-dev task.
export function SubAgentActions() {
  useCopilotAction({
    name: "listSubAgents",
    description: "List available sub-agents (id, name, type local|claude, description) you can delegate to.",
    parameters: [],
    handler: async () => {
      const res = await fetch("/api/subagents").then((r) => r.json());
      return JSON.stringify(
        (res.subAgents ?? []).map((a: { id: string; name: string; type: string; description: string }) => ({
          id: a.id,
          type: a.type,
          description: a.description,
        })),
      );
    },
  });

  useCopilotAction({
    name: "createSubAgent",
    description:
      "Create a reusable sub-agent. type must be 'claude' for development/coding agents, otherwise 'local'. Persisted as markdown under data/agents.",
    parameters: [
      { name: "name", type: "string", description: "Sub-agent name", required: true },
      { name: "description", type: "string", description: "What it is good at", required: true },
      { name: "type", type: "string", description: "'local' or 'claude'", required: true },
      { name: "systemPrompt", type: "string", description: "Instructions defining the sub-agent", required: true },
      { name: "subagentType", type: "string", description: "For 'claude' agents: the harness Agent subagent_type to use (a registered agent type on the harness). Defaults to the agent id.", required: false },
    ],
    handler: async ({ name, description, type, systemPrompt, subagentType }) => {
      const res = await fetch("/api/subagents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, type, systemPrompt, subagentType }),
      }).then((r) => r.json());
      return res.error ? `Error: ${res.error}` : `Created ${res.subAgent.type} sub-agent "${res.subAgent.name}" (${res.subAgent.id}).`;
    },
  });

  useCopilotAction({
    name: "delegateToSubAgent",
    description:
      "Delegate a task to a sub-agent. Provide an existing 'agent' id/name, OR an 'ephemeral' agent spec to create-and-run a one-off agent. Use a Claude agent (type 'claude') for ALL development tasks; Local otherwise.",
    parameters: [
      { name: "agent", type: "string", description: "Existing sub-agent id/name (optional if ephemeral)", required: false },
      { name: "task", type: "string", description: "The task to perform", required: true },
      { name: "ephemeralName", type: "string", description: "For a one-off agent: its name", required: false },
      { name: "ephemeralType", type: "string", description: "'local' or 'claude'", required: false },
      { name: "ephemeralSystemPrompt", type: "string", description: "For a one-off agent: its instructions", required: false },
      { name: "ephemeralSubagentType", type: "string", description: "For a one-off 'claude' agent: harness subagent_type (defaults to the name)", required: false },
      { name: "contentOnly", type: "boolean", description: "Set true when the task only PRODUCES content and does not edit BOS source code (e.g. generating an app's HTML to install). Skips provisioning a BOS-code candidate worktree.", required: false },
    ],
    handler: async ({ agent, task, ephemeralName, ephemeralType, ephemeralSystemPrompt, ephemeralSubagentType, contentOnly }) => {
      const ephemeral = ephemeralName && ephemeralSystemPrompt
        ? { name: ephemeralName, type: ephemeralType === "claude" ? "claude" : "local", systemPrompt: ephemeralSystemPrompt, subagentType: ephemeralSubagentType }
        : undefined;
      const key = String(task ?? "");
      startDelegation(key);
      // Read the NDJSON stream so sub-agent tool events render live.
      let result: DelegateResult | null = null;
      try {
        const res = await fetch("/api/subagents/delegate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent, task, ephemeral, contentOnly: contentOnly === true }),
        });
        if (!res.ok) {
          finishDelegation(key, "");
          const j = await res.json().catch(() => ({}));
          return `Error: ${j.error ?? res.statusText}`;
        }
        if (!res.body) throw new Error("No response stream");
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const s = line.trim();
            if (!s) continue;
            let ev: { type: string; tool?: string; input?: unknown; result?: DelegateResult; error?: string };
            try { ev = JSON.parse(s); } catch { continue; }
            if (ev.type === "tool") pushDelegationEvent(key, { tool: ev.tool ?? "tool", input: ev.input });
            else if (ev.type === "done") result = ev.result ?? null;
            else if (ev.type === "error") return `Error: ${ev.error}`;
          }
        }
      } catch (err) {
        finishDelegation(key, "");
        return `Error: ${(err as Error).message}`;
      }
      const r = result ?? { agent: String(agent ?? ephemeral?.name ?? ""), type: "local", steps: 0, toolCalls: [], output: "" };
      const output = r.output || r.error || "";
      finishDelegation(key, output);
      const summary = `[${r.agent} · ${r.type}] ${r.steps} step(s)\n\n${output}`;
      return summary + encodeNested({
        events: (r.toolCalls ?? []).map((t) => ({ tool: t.tool, input: t.input })),
        output,
      });
    },
  });

  // Elicitation card: ask the user before using a Claude agent for a NON-dev task.
  useCopilotAction({
    name: "requestClaudeAgentPermission",
    description:
      "Ask the user for permission to use a Claude (Claude Code) sub-agent for a NON-development task. Returns one of: once, session, local. Required before using a Claude agent for anything that isn't development/coding.",
    parameters: [{ name: "task", type: "string", description: "What you want the Claude agent to do", required: true }],
    renderAndWaitForResponse: ({ args, status, respond }) => {
      if (status === "complete") {
        return <div className="my-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-white/60">Claude-agent choice recorded.</div>;
      }
      const pick = (c: Choice) => respond?.(c);
      return (
        <div className="my-1 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-xs">
          <div className="mb-2 text-amber-100">
            The assistant wants to use a <b>Claude agent</b> for a non-development task:
            <div className="mt-1 text-white/70">{String(args?.task ?? "")}</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => pick("once")} className="rounded bg-amber-400/20 px-2.5 py-1 font-medium hover:bg-amber-400/30">Allow Claude once</button>
            <button onClick={() => pick("session")} className="rounded bg-amber-400/20 px-2.5 py-1 font-medium hover:bg-amber-400/30">Allow this session</button>
            <button onClick={() => pick("local")} className="rounded bg-white/10 px-2.5 py-1 font-medium hover:bg-white/20">Use Local</button>
          </div>
        </div>
      );
    },
  });

  return null;
}
