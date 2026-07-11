import "server-only";
import { logger } from "@/lib/logging";
import { runToolLoop, type LlmTool } from "@/lib/agent/llm";
import { hasCredentials } from "@/lib/agent/provider";
import { makeMemoryTools } from "@/lib/agent/memory/tool";
import { listSkills, getSkill } from "@/lib/agent/skills/store";
import { improveSkill } from "@/lib/agent/skills/improve";
import { touchSkill } from "@/lib/agent/skills/usage";
import { buildCompactedTranscript } from "@/lib/agent/compaction/summarize";

// Self-improvement (003-self-improvement, revised). Triggered by the live agent
// via the `self_improve` action when the user criticizes HOW a task was done.
// The agent passes an honest reflection; the conversationId is injected by the
// action (never hallucinated). This runs asynchronously so the user is never
// blocked while the system improves — the Assistant app shows a running/done
// indicator by polling getSelfImproveStatus().

const LOG = "self-improve";

export type SelfImproveState = "running" | "done" | "error";

export interface SelfImproveStatus {
  state: SelfImproveState;
  startedAt: number;
  finishedAt?: number;
  /** One-line summary of what changed (skills improved / memory saved). */
  summary?: string;
  error?: string;
}

// Per-conversation status. In-memory is sufficient — this is transient UI state;
// a process restart simply clears any in-flight indicator.
const statusByConv = new Map<string, SelfImproveStatus>();

export function getSelfImproveStatus(conversationId: string): SelfImproveStatus | null {
  return statusByConv.get(conversationId) ?? null;
}

export type SelfImproveTrigger =
  | { kind: "reflection"; reflection: string }
  | { kind: "thumbs_down"; items: { text: string; note?: string }[] };

const SELF_IMPROVE_SYSTEM = [
  "You are the self-improvement analyzer for the BrowserOS assistant. The user was dissatisfied with HOW the assistant did something. You are given EITHER the assistant's own honest reflection, OR the specific response(s) the user rated thumbs-down, plus the (compacted) conversation. Find the ROOT CAUSE and fix it durably so the next similar task goes better.",
  "",
  "## Decide where the problem lives, then act",
  "- If the flawed behavior came from a SKILL's instructions: call skill_list, read the relevant one(s) with skill_view, then skill_improve(id, feedback) with specific feedback. It may be MORE THAN ONE skill — fix each.",
  "- If it is NOT a skill — a user preference, a durable fact/convention, or missing knowledge — record it with memory_save into an appropriate topic so it is injected into future prompts.",
  "- If the criticism is a one-off, non-generalizable whim, or a transient/environment-specific failure: do NOTHING (making no tool calls is valid).",
  "",
  "## Rules",
  "- Prefer improving an EXISTING skill over anything else when a used skill was at fault; do not create new skills here.",
  "- Be honest and specific in the feedback you pass to skill_improve — name what was wrong and what the better approach is.",
  "- Do not harden transient failures or negative tool claims.",
  "- End with a one-line summary of exactly what you changed (or 'No durable change needed.').",
].join("\n");

function buildTools(agentId: string, state: { improvedSkills: string[]; memoryWrites: number }): Record<string, LlmTool> {
  return {
    ...makeMemoryTools(agentId),
    skill_list: {
      description: "List existing skills (id, name, description, whenToUse). Call before improving.",
      parameters: { type: "object", properties: {} },
      execute: async () =>
        JSON.stringify(
          (await listSkills()).map((s) => ({ id: s.id, name: s.name, description: s.description, whenToUse: s.whenToUse })),
        ),
    },
    skill_view: {
      description: "Read a skill's full instructions by id or name.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      execute: async (i) => {
        const s = await getSkill(String(i.id));
        return s ? s.content : `No skill "${i.id}".`;
      },
    },
    skill_improve: {
      description:
        "Improve an existing skill's instructions from the feedback (GEPA reflective optimization; updates the skill's quality score, which may go up or down). Provide the skill id/name and specific, honest feedback.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, feedback: { type: "string" } },
        required: ["id", "feedback"],
      },
      execute: async (i) => {
        const r = await improveSkill(String(i.id), String(i.feedback));
        if (!r) return `Could not improve "${i.id}" (not found or no provider).`;
        await touchSkill(r.id, "patch");
        state.improvedSkills.push(r.id);
        logger().info(LOG, "op: skill_improve", { id: r.id, name: r.name, score: r.score });
        return `Improved "${r.name}" (score ${r.score}).`;
      },
    },
  };
}

function renderTrigger(trigger: SelfImproveTrigger): string {
  if (trigger.kind === "reflection") {
    return `The assistant's reflection on the user's criticism:\n${trigger.reflection.trim()}`;
  }
  const lines = trigger.items.map((it, i) => {
    const note = it.note?.trim() ? `\n(user note: ${it.note.trim()})` : "";
    return `${i + 1}) ${it.text.trim()}${note}`;
  });
  return `The user gave a thumbs-down (negative rating) on the following assistant response(s). Treat this as dissatisfaction with the approach and decide what to improve:\n\n${lines.join("\n\n")}`;
}

async function runSelfImprove(agentId: string, conversationId: string, trigger: SelfImproveTrigger): Promise<void> {
  const log = (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) =>
    logger().log({ level, component: LOG, conversation: conversationId, msg, ...(data ? { data } : {}) });

  try {
    if (!(await hasCredentials())) {
      statusByConv.set(conversationId, { state: "error", startedAt: Date.now(), finishedAt: Date.now(), error: "no AI provider configured" });
      log("warn", "self-improve skipped — no credentials");
      return;
    }
    const transcript = await buildCompactedTranscript(conversationId);
    const state = { improvedSkills: [] as string[], memoryWrites: 0 };
    const tools = buildTools(agentId, state);
    const prompt = [
      renderTrigger(trigger),
      "",
      "The conversation (compacted):",
      transcript || "_(transcript unavailable)_",
    ].join("\n");

    log("info", "self-improve analyzing", { agentId, trigger: trigger.kind });
    const result = await runToolLoop({ system: SELF_IMPROVE_SYSTEM, prompt, tools, maxSteps: 10 });

    const summary = result.text.trim() || `Improved ${state.improvedSkills.length} skill(s).`;
    statusByConv.set(conversationId, { state: "done", startedAt: statusByConv.get(conversationId)?.startedAt ?? Date.now(), finishedAt: Date.now(), summary });
    log("info", "self-improve done", { agentId, improvedSkills: state.improvedSkills, summary: summary.slice(0, 200) });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    statusByConv.set(conversationId, { state: "error", startedAt: statusByConv.get(conversationId)?.startedAt ?? Date.now(), finishedAt: Date.now(), error: message });
    log("error", "self-improve failed", { error: message });
  }
}

/** Kick off a self-improvement pass in the background. Returns immediately; the
 *  caller (and the Assistant UI) tracks progress via getSelfImproveStatus().
 *  Triggered either by the live agent's `self_improve` action (reflection) or by
 *  the fast loop finding thumbs-down feedback. */
export function startSelfImprove(input: { agentId: string; conversationId: string; trigger: SelfImproveTrigger }): void {
  const { agentId, conversationId, trigger } = input;
  statusByConv.set(conversationId, { state: "running", startedAt: Date.now() });
  void runSelfImprove(agentId, conversationId, trigger);
}
