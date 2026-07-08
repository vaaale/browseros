import "server-only";
import { promises as fs } from "fs";
import * as vfs from "@/os/vfs";
import { hostPath } from "@/os/vfs";
import { logger } from "@/lib/logging";
import { runToolLoop, type LlmTool } from "@/lib/agent/llm";
import { hasCredentials } from "@/lib/agent/provider";
import { patchSkill, getSkill } from "@/lib/agent/skills/store";
import { touchSkill } from "@/lib/agent/skills/usage";
import { ensureSystemJob, type HandlerRunResult } from "@/lib/scheduler/engine";
import type { JobDefinition } from "@/lib/scheduler/types";
import { registerInternalRef } from "./internal-handler";
import {
  createEpisode,
  getEpisode,
  updateEpisode,
  type EpisodeSection,
  type EpisodeUpdate,
} from "./episodes";
import { getWatermarkEntry, setWatermark } from "./watermarks";
import { getMemoryLoopsConfig } from "./config";

// Fast loop (spec 021 §Fast loop). Runs as a System JobDefinition every ~2 min
// through the Unified Job Engine, scans idle conversations, and writes/updates
// an episode file per conversation. Toolset is deliberately restricted to
// `episode_write` + `skill_patch` — the fast loop MUST NOT create skills, and
// MUST NOT touch USER.md / MEMORY.md / topics (those are the slow loop's job).

const LOG = "memory.fast-loop";

export const FAST_LOOP_JOB_ID = "system:memory.fast-loop";
export const FAST_LOOP_HANDLER_REF = "memory.fast-loop";

const CHATS_DIR = "/Documents/Chats";

// ── Embedded system prompt (FR-021) ───────────────────────────────────────
// Bundled at specs/bos-system-specs/021-memory-loops/prompts/fast-loop-system.md
// and inlined here per FR-021. Any wording change is a spec change.
export const FAST_LOOP_SYSTEM_PROMPT = [
  "You are the fast-loop reviewer, analyzing recent conversation turns to extract episodic memories. Your job is to review ONLY the new turns since the last review (after the watermark) and update the episode file with lessons learned.",
  "",
  "## Scope",
  "- You see only the transcript slice after the watermark.",
  "- Do NOT re-review old content; focus on what's new.",
  "- The existing episode body is provided for context; preserve its sections and add/update only where needed.",
  "",
  "## Output Requirements",
  "Update the episode with these sections (create if missing, update if present):",
  "- Task & outcome — what the user was trying to accomplish, whether it succeeded, and the key steps taken.",
  "- What worked / what failed — approaches or tools that worked; dead ends, errors encountered.",
  "- Corrections received — explicit user corrections and mid-conversation clarifications.",
  "- Durable lesson candidates — lessons worth saving to long-term memory (tentative; consolidation decides).",
  "- Profile suggestions — observations about the user (SUGGESTIONS only; DO NOT write to USER.md).",
  "",
  "## Restrictions",
  "- NO skill creation. If a complex novel task was solved, record it in `skillCandidates` for the slow loop.",
  "- NO writes to USER.md/MEMORY.md/topics. Episodic only.",
  "- NO re-reviewing old turns.",
  "",
  "## Anti-Patterns (Do NOT Harden These)",
  "- Transient failures (network hiccups, temporary API errors that resolved themselves).",
  "- Negative tool claims (\"I can't do X\" when the tool later succeeded or the user worked around it).",
  "- Resolved errors that were caught and fixed within the same conversation.",
  "- One-off narratives not generalizable to future tasks.",
  "",
  "## Tools",
  "You have access ONLY to:",
  "- episode_write(sections) — update the episode file. `sections` maps any of the section headers above to markdown content.",
  "- skill_patch(id, find, replace) — patch an existing skill ONLY if it was explicitly corrected in the session. Never patch for minor stylistic variations.",
  "",
  "You do NOT have skill_create, memory_add_entry, memory_replace_entry, topic_create, or any raw file write.",
  "",
  "'Nothing to save' is valid: for a smooth session with no corrections and no new technique, make no tool calls and reply 'Nothing to save.'",
].join("\n");

// ── Configuration ────────────────────────────────────────────────────────

const DEFAULTS = {
  idleThresholdSec: 300,
  turnCap: 40,
  minNewTurns: 4,
  intervalMinutes: 2,
};

// ── Conversation scanning ────────────────────────────────────────────────

interface AnyMessage {
  id?: string;
  role?: string;
  content?: unknown;
  toolCalls?: unknown[];
  createdAt?: number | string;
  timestamp?: number | string;
}

interface ConversationFileShape {
  id?: string;
  title?: string;
  createdAt?: number;
  messages?: AnyMessage[];
}

export interface ConversationRef {
  id: string;
  title: string;
  path: string;
  messages: AnyMessage[];
  /** Last-mtime as ms since epoch — used as the idle timer. */
  mtimeMs: number;
}

async function listChatFiles(): Promise<{ id: string; path: string; mtimeMs: number }[]> {
  try {
    const entries = await vfs.list(CHATS_DIR);
    const files = entries.filter((e) => e.type === "file" && e.name.endsWith(".json"));
    const out: { id: string; path: string; mtimeMs: number }[] = [];
    for (const e of files) {
      let mtimeMs = e.modified ?? 0;
      if (!mtimeMs) {
        try {
          mtimeMs = (await fs.stat(hostPath(e.path))).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
      }
      out.push({ id: e.name.replace(/\.json$/, ""), path: e.path, mtimeMs });
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function readConversation(id: string, path: string, mtimeMs: number): Promise<ConversationRef | null> {
  try {
    const raw = await vfs.readText(path);
    const parsed = JSON.parse(raw) as ConversationFileShape;
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    return {
      id: parsed.id ?? id,
      title: typeof parsed.title === "string" ? parsed.title : "Conversation",
      path,
      messages,
      mtimeMs,
    };
  } catch {
    return null;
  }
}

function messageId(m: AnyMessage, fallbackIndex: number): string {
  if (typeof m.id === "string" && m.id) return m.id;
  return String(fallbackIndex);
}

function findWatermarkIndex(messages: AnyMessage[], watermark: string | null): number {
  if (!watermark) return -1;
  // Try id-based first (canonical), then numeric-index fallback.
  for (let i = 0; i < messages.length; i++) {
    if (typeof messages[i].id === "string" && messages[i].id === watermark) return i;
  }
  const idx = Number.parseInt(watermark, 10);
  if (Number.isFinite(idx)) return Math.max(-1, Math.min(messages.length - 1, idx));
  return -1;
}

function countAssistantTurns(messages: AnyMessage[]): number {
  let n = 0;
  for (const m of messages) if (m?.role === "assistant") n += 1;
  return n;
}

interface EligibilityResult {
  eligible: boolean;
  reason: "idle" | "turn-cap" | "closed" | "insufficient-turns" | "no-new-turns";
  newSlice: AnyMessage[];
  fromIndex: number;
}

function evaluateEligibility(
  conv: ConversationRef,
  watermark: string | null,
  now: number,
  cfg: { idleThresholdSec: number; turnCap: number; minNewTurns: number },
): EligibilityResult {
  const messages = conv.messages;
  const wmIdx = findWatermarkIndex(messages, watermark);
  const newSlice = messages.slice(wmIdx + 1);

  if (newSlice.length === 0) {
    return { eligible: false, reason: "no-new-turns", newSlice, fromIndex: wmIdx + 1 };
  }
  const newAssistantTurns = countAssistantTurns(newSlice);
  if (newAssistantTurns < cfg.minNewTurns) {
    // Turn cap can still force us to review long unreviewed backlogs.
    if (newSlice.length >= cfg.turnCap) {
      return { eligible: true, reason: "turn-cap", newSlice, fromIndex: wmIdx + 1 };
    }
    return { eligible: false, reason: "insufficient-turns", newSlice, fromIndex: wmIdx + 1 };
  }
  const idleMs = now - conv.mtimeMs;
  if (idleMs >= cfg.idleThresholdSec * 1000) {
    return { eligible: true, reason: "idle", newSlice, fromIndex: wmIdx + 1 };
  }
  if (newSlice.length >= cfg.turnCap) {
    return { eligible: true, reason: "turn-cap", newSlice, fromIndex: wmIdx + 1 };
  }
  return { eligible: false, reason: "no-new-turns", newSlice, fromIndex: wmIdx + 1 };
}

// ── Transcript slice → LLM input ─────────────────────────────────────────

function renderSlice(messages: AnyMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const role = String(m?.role ?? "unknown");
    let content: string;
    if (typeof m?.content === "string") content = m.content;
    else if (m?.content == null) content = "";
    else content = safeStringify(m.content);
    lines.push(`### ${role}\n${content.trim()}`);
    if (Array.isArray(m?.toolCalls) && m.toolCalls.length > 0) {
      lines.push(`_tool calls_: ${safeStringify(m.toolCalls)}`);
    }
  }
  return lines.join("\n\n");
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Extract skill ids referenced in the transcript's tool calls. Mechanical
 *  capture per FR-008 — the LLM never decides skillsUsed. */
function extractSkillsUsed(messages: AnyMessage[]): string[] {
  const ids = new Set<string>();
  for (const m of messages) {
    const calls = Array.isArray(m?.toolCalls) ? m.toolCalls : [];
    for (const c of calls) {
      if (!c || typeof c !== "object") continue;
      const call = c as { name?: unknown; toolName?: unknown; input?: unknown; arguments?: unknown };
      const name = String(call.name ?? call.toolName ?? "");
      if (name === "skill_use" || name === "skill_read" || name === "skill_view" || name === "skill_run") {
        const input = (call.input ?? call.arguments ?? {}) as Record<string, unknown>;
        const id = String(input.id ?? input.skillId ?? input.name ?? "").trim();
        if (id) ids.add(id);
      }
    }
  }
  return Array.from(ids);
}

// ── Restricted LLM toolset ───────────────────────────────────────────────

interface FastLoopTools {
  episodeUpdates: EpisodeUpdate;
  refusedInjection: number;
  patchedSkills: string[];
}

function buildFastLoopTools(state: FastLoopTools): Record<string, LlmTool> {
  return {
    episode_write: {
      description:
        "Update the current episode file. `sections` maps section names to markdown content. Sections: 'Task & outcome', 'What worked / what failed', 'Corrections received', 'Durable lesson candidates', 'Profile suggestions'. You may also set skillCandidates (array of task-class slugs).",
      parameters: {
        type: "object",
        properties: {
          sections: {
            type: "object",
            description: "Section name → markdown body. Provide only the sections you are updating.",
          },
          skillCandidates: {
            type: "array",
            items: { type: "string" },
            description: "Task-class slugs to add to the episode for the slow loop's recurrence gate.",
          },
        },
      },
      execute: async (input) => {
        const sections = (input.sections ?? {}) as Record<string, unknown>;
        const nextSections: Partial<Record<EpisodeSection, string>> = {};
        for (const [k, v] of Object.entries(sections)) {
          if (typeof v !== "string") continue;
          nextSections[k as EpisodeSection] = v;
        }
        if (Object.keys(nextSections).length > 0) {
          state.episodeUpdates.sections = { ...(state.episodeUpdates.sections ?? {}), ...nextSections };
        }
        if (Array.isArray(input.skillCandidates)) {
          state.episodeUpdates.skillCandidates = [
            ...(state.episodeUpdates.skillCandidates ?? []),
            ...input.skillCandidates.filter((s): s is string => typeof s === "string"),
          ];
        }
        return "ok";
      },
    },
    skill_patch: {
      description:
        "Patch an EXISTING skill that was explicitly corrected during the session. Replaces the first occurrence of `find` in the skill body with `replace`. Do NOT patch for minor stylistic preferences.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          find: { type: "string" },
          replace: { type: "string" },
        },
        required: ["id", "find", "replace"],
      },
      execute: async (input) => {
        const id = String(input.id ?? "");
        const find = String(input.find ?? "");
        const replace = String(input.replace ?? "");
        const skill = await getSkill(id);
        if (!skill) return `No skill "${id}".`;
        const r = await patchSkill(skill.id, find, replace);
        if ("error" in r) return `Error: ${r.error}`;
        await touchSkill(r.id, "patch");
        state.patchedSkills.push(r.id);
        return `Patched "${r.name}".`;
      },
    },
  };
}

// ── Public run API ───────────────────────────────────────────────────────

export interface FastLoopRunSummary {
  ran: boolean;
  reason?: string;
  scanned: number;
  eligible: number;
  reviewed: number;
  episodesUpdated: string[];
  skillsPatched: string[];
  errors: { conversationId: string; error: string }[];
}

/** Run the fast loop over every eligible conversation. Called by the scheduler
 *  handler and by the manual trigger route. `onlyConversationId` narrows to a
 *  single conversation and waives the idle threshold (manual re-run). */
export async function runFastLoop(opts: {
  onlyConversationId?: string;
  waiveIdle?: boolean;
} = {}): Promise<FastLoopRunSummary> {
  const summary: FastLoopRunSummary = {
    ran: false,
    scanned: 0,
    eligible: 0,
    reviewed: 0,
    episodesUpdated: [],
    skillsPatched: [],
    errors: [],
  };

  const cfg = await getMemoryLoopsConfig();
  if (!cfg.fastLoop.enabled) {
    summary.reason = "fast loop disabled";
    return summary;
  }
  if (!(await hasCredentials())) {
    summary.reason = "no AI provider configured";
    return summary;
  }

  const files = await listChatFiles();
  const now = Date.now();
  for (const f of files) {
    if (opts.onlyConversationId && f.id !== opts.onlyConversationId) continue;
    summary.scanned += 1;

    const conv = await readConversation(f.id, f.path, f.mtimeMs);
    if (!conv || conv.messages.length === 0) continue;

    const wm = await getWatermarkEntry(conv.id);
    const elig = evaluateEligibility(
      conv,
      wm?.messageId ?? null,
      now,
      {
        idleThresholdSec: opts.waiveIdle ? 0 : cfg.fastLoop.idleThresholdSec,
        turnCap: cfg.fastLoop.turnCap,
        minNewTurns: cfg.fastLoop.minNewTurns,
      },
    );
    if (!elig.eligible) continue;
    summary.eligible += 1;

    try {
      await reviewSlice(conv, elig.newSlice, elig.fromIndex, summary);
      summary.reviewed += 1;
    } catch (err) {
      summary.errors.push({ conversationId: conv.id, error: (err as Error).message });
      logger().error(LOG, "review failed", err, { conversationId: conv.id });
    }
  }

  summary.ran = true;
  logger().info(LOG, "fast loop run", {
    scanned: summary.scanned,
    eligible: summary.eligible,
    reviewed: summary.reviewed,
    episodesUpdated: summary.episodesUpdated.length,
    skillsPatched: summary.skillsPatched.length,
  });
  return summary;
}

async function reviewSlice(
  conv: ConversationRef,
  slice: AnyMessage[],
  fromIndex: number,
  summary: FastLoopRunSummary,
): Promise<void> {
  await createEpisode(conv.id);

  const state: FastLoopTools = {
    episodeUpdates: {},
    refusedInjection: 0,
    patchedSkills: [],
  };
  const tools = buildFastLoopTools(state);
  const existing = await getEpisode(conv.id);
  const existingBody = existing
    ? Object.entries(existing.sections)
        .filter(([, v]) => v && v.trim())
        .map(([k, v]) => `## ${k}\n${v}`)
        .join("\n\n")
    : "";

  const skillsMechanical = extractSkillsUsed(slice);
  const transcript = renderSlice(slice);

  const prompt = [
    `Conversation: ${conv.title || conv.id}`,
    `Existing episode body (context — do not re-review earlier content):`,
    existingBody ? existingBody : "_(new episode; no prior body)_",
    "",
    "New turns since last review:",
    transcript,
  ].join("\n\n");

  await runToolLoop({
    system: FAST_LOOP_SYSTEM_PROMPT,
    prompt,
    tools,
    maxSteps: 8,
  });

  // Advance watermark to the last message we reviewed.
  const lastMessage = conv.messages[conv.messages.length - 1];
  const lastId = lastMessage ? messageId(lastMessage, conv.messages.length - 1) : String(fromIndex + slice.length - 1);

  const updates: EpisodeUpdate = { ...state.episodeUpdates, watermark: lastId };
  if (skillsMechanical.length > 0) updates.skillsUsed = skillsMechanical;

  await updateEpisode(conv.id, updates);
  await setWatermark(conv.id, lastId);

  summary.episodesUpdated.push(conv.id);
  for (const id of state.patchedSkills) summary.skillsPatched.push(id);
}

// ── Scheduler wiring ─────────────────────────────────────────────────────

let seededOnce = false;

/** Seed the fast-loop JobDefinition into the unified store. Idempotent (spec
 *  FR-004 / Task 2.1). Uses the caller-provided interval or the config default. */
export async function ensureFastLoopJob(): Promise<JobDefinition> {
  registerInternalRef(FAST_LOOP_HANDLER_REF, async () => runAsHandler());

  const cfg = await getMemoryLoopsConfig();
  const intervalMinutes = Math.max(1, Math.round(cfg.fastLoop.tickIntervalSec / 60) || DEFAULTS.intervalMinutes);
  const job = await ensureSystemJob({
    id: FAST_LOOP_JOB_ID,
    name: "Memory: Fast Loop",
    owner: "memory",
    handler: { kind: "internal", ref: FAST_LOOP_HANDLER_REF },
    scheduleConfig: { type: "recurring", interval: intervalMinutes, unit: "minute" },
    readOnlyFields: ["handler"],
  });
  if (!seededOnce) {
    seededOnce = true;
    logger().info(LOG, "fast-loop job seeded", { jobId: job.id, interval: intervalMinutes });
  }
  return job;
}

async function runAsHandler(): Promise<HandlerRunResult> {
  const summary = await runFastLoop();
  if (summary.errors.length > 0) {
    return {
      status: "error",
      error: summary.errors.map((e) => `${e.conversationId}: ${e.error}`).join("; "),
      output: `${summary.reviewed}/${summary.eligible} reviewed; ${summary.errors.length} error(s)`,
    };
  }
  return {
    status: "success",
    output: `scanned=${summary.scanned} eligible=${summary.eligible} reviewed=${summary.reviewed}`,
  };
}
