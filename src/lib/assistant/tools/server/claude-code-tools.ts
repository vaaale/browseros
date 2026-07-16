import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import type { Agent } from "@/lib/agent/subagents/types";
import { getAgent } from "@/lib/agent/subagents/store";
import { delegateToAgent } from "./delegate-common";

// Thin wrappers matching the Claude Code Agent tool schema so skills authored
// for Claude Code (e.g. deep-research, brainstorming) work inside BOS without
// having to know about agent_delegate's BOS-specific type field.
//
// Mapping:
//   subagent_type "Developer" → persisted "developer" agent (type: "claude",
//     Developer harness, requires a feature branch) — same path as dev_delegate
//   everything else → ephemeral local agent (inner-loop, inherits web tools)
//
// run_in_background and isolation are Claude Code-specific; accepted in the
// schema so the model doesn't see an unknown-parameter error, but not acted on.

const SUBAGENT_PROMPTS: Record<string, string> = {
  explore:
    "You are a fast read-only search agent. Use available tools to locate files by pattern, grep for symbols or keywords, and answer questions about where things are defined or referenced. Do not write or modify files.",
  plan:
    "You are a software architect agent. Design step-by-step implementation plans, identify critical files, and consider architectural trade-offs. Return a structured plan — do not implement.",
  "general-purpose": "",
};

function systemPromptFor(subagentType: string | undefined): string {
  if (!subagentType) return "";
  return SUBAGENT_PROMPTS[subagentType.toLowerCase()] ?? "";
}

export function claudeCodeTools(): Record<string, AssistantTool> {
  return {
    Agent: serverTool(
      "Agent",
      "Launch a sub-agent to handle a task. Use subagent_type 'Developer' for BrowserOS source code changes (same as dev_delegate, requires a feature branch). Omit subagent_type or use 'Explore' / 'general-purpose' for research, search, and reasoning tasks.",
      schema(
        {
          description: p.str("Short description of the task (3–5 words)"),
          prompt: p.str("The full task for the agent to perform"),
          subagent_type: p.str(
            "Agent specialisation: 'Developer' for code changes, 'Explore' for read-only search, 'general-purpose' for reasoning. Omit for a generic agent.",
          ),
          model: p.str("Optional model override"),
          run_in_background: p.bool("Not supported in BOS — accepted but ignored"),
          isolation: p.str("Not supported in BOS — accepted but ignored"),
        },
        ["prompt"],
      ),
      async (input, ctx) => {
        const prompt = String(input.prompt ?? "");
        if (!prompt) return "Error: Agent: prompt is required.";

        const rawType = input.subagent_type ? String(input.subagent_type) : undefined;

        if (rawType?.toLowerCase() === "developer") {
          const dev = await getAgent("developer");
          if (!dev)
            return "Error: Agent: no 'developer' sub-agent is registered. Set one up in Settings → Agents first.";
          return delegateToAgent(dev, false, prompt, ctx, false, "Agent");
        }

        const name = input.description ? String(input.description) : (rawType ?? "Agent");
        const def: Agent = {
          id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent",
          name,
          description: "",
          type: "local",
          systemPrompt: systemPromptFor(rawType),
          model: input.model ? String(input.model) : undefined,
          ephemeral: true,
        };

        return delegateToAgent(def, true, prompt, ctx, false, "Agent");
      },
    ),
  };
}
