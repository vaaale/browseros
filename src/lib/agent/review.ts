import "server-only";
import { runToolLoop, type LlmTool } from "@/lib/agent/llm";
import { hasCredentials } from "@/lib/agent/provider";
import { MEMORY_LLM_TOOL } from "@/lib/agent/memory/tool";
import { listSkills, getSkill, saveSkill, patchSkill } from "@/lib/agent/skills/store";
import { touchSkill } from "@/lib/agent/skills/usage";

// The self-improvement review (specs/003-self-improvement/spec.md §2): a separate pass,
// restricted to the memory + skill-management tools, that inspects a completed
// conversation and decides what to save/update. It can take no other action.

const SKILL_TOOLS: Record<string, LlmTool> = {
  skill_list: {
    description: "List existing skills (id, name, description, when-to-use). Use before creating to avoid duplicates.",
    parameters: { type: "object", properties: {} },
    execute: async () =>
      JSON.stringify((await listSkills()).map((s) => ({ id: s.id, name: s.name, description: s.description, whenToUse: s.whenToUse }))),
  },
  skill_view: {
    description: "Read a skill's full instructions by id or name.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute: async (i) => {
      const s = await getSkill(String(i.id));
      return s ? s.content : `No skill "${i.id}".`;
    },
  },
  skill_patch: {
    description:
      "Improve an existing skill: replace a unique snippet of its instructions with new text (embed the lesson, a new step, or a pitfall). Prefer this over creating a new skill.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, find: { type: "string" }, replace: { type: "string" } },
      required: ["id", "find", "replace"],
    },
    execute: async (i) => {
      const r = await patchSkill(String(i.id), String(i.find), String(i.replace));
      if ("error" in r) return `Error: ${r.error}`;
      await touchSkill(r.id, "patch");
      return `Patched "${r.name}".`;
    },
  },
  skill_create: {
    description:
      "Create a new CLASS-LEVEL skill (only when no existing skill covers the class). The name must be at the class level — never a session artifact (a bug id, error string, codename, or 'fix-X-today').",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string", description: "One sentence." },
        whenToUse: { type: "string" },
        content: { type: "string", description: "Step-by-step instructions." },
      },
      required: ["name", "content"],
    },
    execute: async (i) => {
      const s = await saveSkill({
        name: String(i.name),
        description: String(i.description ?? ""),
        whenToUse: i.whenToUse as string | undefined,
        content: String(i.content),
        createdBy: "agent",
        score: 1,
      });
      await touchSkill(s.id, "patch");
      return `Created skill "${s.name}".`;
    },
  },
};

const REVIEW_SYSTEM = [
  "You are the self-improvement review for the BrowserOS assistant. You are given a completed conversation. Decide what is worth saving so the next session is better. You may ONLY use the memory and skill tools — you take no other action.",
  "",
  "MEMORY (the `memory` tool): save to target 'user' when the user revealed identity, durable preferences, or expectations; to target 'memory' when a durable environment fact, convention, or lesson emerged.",
  "",
  "SKILLS: be active — most non-trivial sessions yield at least one skill update. Signals (any one warrants action): the user corrected your style/format/verbosity/approach (frustration is a first-class signal); the user corrected a workflow; a non-trivial technique/fix/workaround emerged; a skill that was used proved wrong or outdated.",
  "Preference order — pick the earliest that fits: (1) skill_patch a skill already relevant to the task; (2) skill_patch an existing umbrella skill; (3) skill_create a new CLASS-LEVEL skill only when nothing covers the class.",
  "Embed user style/workflow preferences in the SKILL body, not only in memory.",
  "",
  "DO NOT capture (these harden into self-imposed constraints): environment-dependent failures (missing binaries, unconfigured credentials, 'command not found'); negative claims about tools ('X is broken'); transient errors that resolved; one-off task narratives. If a tool failed due to setup, capture the FIX under a troubleshooting skill — never 'this tool does not work'.",
  "",
  "'Nothing to save' is valid for a smooth session with no corrections and no new technique — in that case make no tool calls and reply 'Nothing to save.' Otherwise, act, then give a one-line summary of what you saved.",
].join("\n");

export interface ReviewResult {
  ran: boolean;
  steps: number;
  summary: string;
}

/** Run the self-improvement review over a conversation transcript. */
export async function runReview(transcript: string): Promise<ReviewResult> {
  if (!transcript.trim()) return { ran: false, steps: 0, summary: "Empty transcript." };
  if (!(await hasCredentials())) return { ran: false, steps: 0, summary: "No AI provider configured." };
  try {
    const result = await runToolLoop({
      system: REVIEW_SYSTEM,
      prompt: `Conversation to review:\n\n${transcript}`,
      tools: { memory: MEMORY_LLM_TOOL, ...SKILL_TOOLS },
      maxSteps: 12,
    });
    return { ran: true, steps: result.steps, summary: result.text.trim() || "Done." };
  } catch (e) {
    return { ran: false, steps: 0, summary: `Review failed: ${(e as Error).message}` };
  }
}

/** Post-task self-reflection entry point (kept name for the assistant action). */
export const reflectAndLearn = runReview;
