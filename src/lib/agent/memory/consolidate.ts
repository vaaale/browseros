import "server-only";
import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import * as vfs from "@/os/vfs";
import { hostPath } from "@/os/vfs";
import { logger } from "@/lib/logging";
import { runToolLoop, type LlmTool } from "@/lib/agent/llm";
import { hasCredentials } from "@/lib/agent/provider";
import { listSkills, getSkill, saveSkill, patchSkill } from "@/lib/agent/skills/store";
import { touchSkill } from "@/lib/agent/skills/usage";
import { addEntry as memoryAdd, replaceEntry as memoryReplace, removeEntry as memoryRemove } from "./curated";
import { ensureSystemJob, type HandlerRunResult } from "@/lib/scheduler/engine";
import type { JobDefinition } from "@/lib/scheduler/types";
import { registerInternalRef } from "./internal-handler";
import {
  archiveOldEpisodes,
  countSkillCandidateOccurrences,
  listPendingEpisodes,
  markEpisodePathConsolidated,
  tagSkillCandidate,
  type Episode,
} from "./episodes";
import {
  addTopicEntry,
  createTopic,
  removeTopicEntry,
  replaceTopicEntry,
} from "./topics";
import { getMemoryLoopsConfig } from "./config";

// Slow loop (spec 021 §Slow loop). Overlap-locked, hourly by default, and
// exits with zero LLM cost when nothing is pending. Registered as a System
// JobDefinition in the unified store via ensureSystemJob.

const LOG = "memory.slow-loop";

export const SLOW_LOOP_JOB_ID = "system:memory.slow-loop";
export const SLOW_LOOP_HANDLER_REF = "memory.slow-loop";

const LOCK_PATH = "/Documents/Memory/.consolidate.lock";
const LOCK_STALE_MS = 30 * 60 * 1000; // 30 minutes

// ── Embedded system prompt (FR-021) ───────────────────────────────────────
// Bundled at specs/bos-system-specs/021-memory-loops/prompts/slow-loop-system.md
// and inlined here per FR-021. Any wording change is a spec change.
export const SLOW_LOOP_SYSTEM_PROMPT = [
  "You are the consolidation engine, merging episodic memories into long-term knowledge. Your job is to review pending episodes and extract durable lessons, patching or creating skills as appropriate.",
  "",
  "## Input",
  "You receive one or more pending episodes, each containing task/outcome, what worked/failed, corrections, durable lesson candidates, profile suggestions, skillsUsed (mechanical), and any skill-candidate tags.",
  "",
  "## Output — Incremental Operations ONLY",
  "You NEVER rewrite whole files. Each op modifies a single entry.",
  "",
  "Memory (topics + MEMORY.md observations):",
  "- memory_add_entry(topic, content) — add an entry to a topic; use topic='memory' for the global MEMORY.md.",
  "- memory_replace_entry(topic, entryIdOrText, newContent) — supersede a stale or contradicted entry.",
  "- memory_remove_entry(topic, entryIdOrText) — remove an entry.",
  "- topic_create(slug, digest) — create a new topic shard when none fits.",
  "",
  "Episodes:",
  "- episode_tag_candidate(episodePath, taskClass) — record a skill-candidate tag for recurrence tracking.",
  "- episode_mark_consolidated(episodePath) — finalize an episode after all its ops succeed.",
  "",
  "Skills:",
  "- skill_list() — always call before creating; prefer skill_patch on an existing skill.",
  "- skill_patch(id, find, replace) — patch an existing skill; used for corrections observed on skillsUsed.",
  "- skill_create(spec) — create a NEW skill ONLY if ALL gate conditions hold (see below).",
  "",
  "## Skill Creation Gate (FR-014)",
  "A skill may be created ONLY if:",
  "  (a) No existing skill covers the task class (skill_list first; prefer skill_patch).",
  "  (b) The task is genuinely complex — multi-step, non-obvious ordering, discovered pitfalls.",
  "  (c) The same task class appears in ≥ 2 episodes (checked via skill-candidate tags across history).",
  "First occurrence: use episode_tag_candidate; do NOT create. Second occurrence: create if (a) and (b) still hold.",
  "",
  "## Anti-Patterns (Do NOT Harden These)",
  "- Transient failures, negative tool claims, resolved errors, one-off narratives.",
  "",
  "## Deduplication & Supersession",
  "- Duplicates: skip.",
  "- Contradictions: memory_replace_entry to supersede, do not append alongside.",
  "- Over budget: reject and either shorten or create a new shard (e.g., gmail-workflows-2).",
  "",
  "## Profile Suggestions",
  "Profile suggestions are OBSERVATIONS, not confirmed identity. Never write to USER.md. Record in MEMORY.md as an 'Observed pattern:' entry so the live agent can confirm and promote if appropriate.",
  "",
  "## Processing Order",
  "For each pending episode (oldest-first):",
  "  1. Review task/outcome/lessons.",
  "  2. For each skillsUsed id: skill_patch when corrected, else no-change.",
  "  3. For each skill-candidate tag: check recurrence; create only if gate met.",
  "  4. Extract durable lessons → memory_add_entry to the right topic.",
  "  5. Handle profile suggestions → memory_add_entry(topic='memory') as observation.",
  "  6. episode_mark_consolidated(episodePath).",
  "Log summary at the end (episodes processed, ops applied, refusals).",
].join("\n");

// ── Overlap lock (FR-011) ────────────────────────────────────────────────

interface LockContent {
  pid: number;
  startedAt: number;
  batchId: string;
}

async function readLock(): Promise<LockContent | null> {
  try {
    const raw = await vfs.readText(LOCK_PATH);
    return JSON.parse(raw) as LockContent;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

async function writeLock(content: LockContent): Promise<void> {
  await vfs.writeText(LOCK_PATH, JSON.stringify(content));
}

async function removeLock(): Promise<void> {
  try {
    await vfs.remove(LOCK_PATH);
  } catch {
    /* best-effort */
  }
}

/** Try to acquire the overlap lock. Returns the lock content on success, or
 *  null when another run holds it and it isn't stale yet. Stale (older than
 *  LOCK_STALE_MS) locks are overwritten. */
export async function acquireLock(): Promise<LockContent | null> {
  const existing = await readLock();
  if (existing) {
    const age = Date.now() - existing.startedAt;
    if (age < LOCK_STALE_MS) {
      logger().info(LOG, "slow-loop lock held; skipping run", { holderPid: existing.pid, ageMs: age });
      return null;
    }
    logger().warn(LOG, "expiring stale slow-loop lock", { holderPid: existing.pid, ageMs: age });
  }
  const content: LockContent = { pid: process.pid, startedAt: Date.now(), batchId: randomUUID() };
  await writeLock(content);
  // Verify we own it (best-effort race check — VFS writes go through atomic
  // temp+rename so this is defensive rather than corrective).
  const check = await readLock();
  if (!check || check.batchId !== content.batchId) return null;
  return content;
}

export async function releaseLock(lock: LockContent): Promise<void> {
  const current = await readLock();
  if (current && current.batchId === lock.batchId) {
    await removeLock();
  }
}

// ── Restricted LLM toolset ───────────────────────────────────────────────

interface SlowLoopState {
  // The specific episode currently being consolidated. Some tools (e.g.
  // episode_mark_consolidated) accept an explicit path but default to this.
  currentEpisode: Episode | null;
  createdSkills: string[];
  patchedSkills: string[];
  memoryOps: number;
  topicOps: number;
  refusedSkillCreates: { taskClass: string; reason: string }[];
  markedConsolidated: string[];
}

/** Run all three skill-creation gate checks (FR-014). Returns null when it's
 *  allowed to create, or a reason string when the gate blocks it. */
export async function evaluateSkillCreationGate(input: {
  taskClass: string;
  name: string;
  description?: string;
  content: string;
  currentEpisode?: Episode | null;
}): Promise<string | null> {
  const taskClass = input.taskClass.trim();
  if (!taskClass) return "task class is required for the skill-creation gate";

  // (a) No existing skill covers this class.
  const skills = await listSkills();
  const needle = taskClass.toLowerCase();
  const overlap = skills.find((s) => {
    const hay = `${s.name} ${s.description ?? ""} ${s.whenToUse ?? ""}`.toLowerCase();
    return hay.includes(needle) || s.id.toLowerCase() === needle;
  });
  if (overlap) return `existing skill "${overlap.name}" (${overlap.id}) already covers "${taskClass}" — use skill_patch instead`;

  // (b) Complexity threshold — heuristic proxy. The prompt already reinforces
  // this; here we require some minimum body length AND multi-step evidence.
  const body = input.content.trim();
  const stepCount = (body.match(/^\s*(?:-|\d+\.)\s+/gm) ?? []).length;
  if (body.length < 200 || stepCount < 3) {
    return `task does not meet complexity threshold — need multi-step body (≥3 steps, ≥200 chars); got ${stepCount} step(s), ${body.length} chars`;
  }

  // (c) Recurrence evidence — count skill-candidate tags across all episodes.
  const occurrences = await countSkillCandidateOccurrences(taskClass);
  if (occurrences < 2) return `first occurrence of task class "${taskClass}" — tag as skill-candidate and wait for recurrence`;

  return null;
}

function buildSlowLoopTools(state: SlowLoopState): Record<string, LlmTool> {
  return {
    memory_add_entry: {
      description:
        "Add an entry to a topic or the global MEMORY.md. Pass topic='memory' for MEMORY.md; any other string is a topic slug (lower-kebab). Duplicates are dropped silently.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string" },
          content: { type: "string" },
        },
        required: ["topic", "content"],
      },
      execute: async (input) => {
        const topic = String(input.topic ?? "").trim();
        const content = String(input.content ?? "").trim();
        if (!topic || !content) return "Error: topic and content are required.";
        if (topic === "memory" || topic === "user") {
          if (topic === "user") return "Refused: the slow loop MUST NOT write USER.md (per spec).";
          const r = await memoryAdd("memory", content);
          if (!r.success) return `Error: ${r.error}`;
          state.memoryOps += 1;
          return `Added to MEMORY.md (${r.usage}).`;
        }
        const r = await addTopicEntry(topic, content);
        if (!r.success) return `Error: ${r.error}`;
        state.topicOps += 1;
        return `Added to topics/${topic} (${r.usage}).`;
      },
    },
    memory_replace_entry: {
      description:
        "Supersede an entry. Provide an entry id OR a unique substring of the old entry text. Use for contradictions — never for stylistic edits.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string" },
          entryIdOrText: { type: "string" },
          newContent: { type: "string" },
        },
        required: ["topic", "entryIdOrText", "newContent"],
      },
      execute: async (input) => {
        const topic = String(input.topic ?? "").trim();
        const key = String(input.entryIdOrText ?? "").trim();
        const newContent = String(input.newContent ?? "").trim();
        if (!topic || !key || !newContent) return "Error: topic, entryIdOrText, and newContent are required.";
        if (topic === "memory") {
          const r = await memoryReplace("memory", key, newContent);
          if (!r.success) return `Error: ${r.error}`;
          state.memoryOps += 1;
          return `Replaced in MEMORY.md.`;
        }
        if (topic === "user") return "Refused: the slow loop MUST NOT write USER.md.";
        const r = await replaceTopicEntry(topic, key, newContent);
        if (!r.success) return `Error: ${r.error}`;
        state.topicOps += 1;
        return `Replaced in topics/${topic}.`;
      },
    },
    memory_remove_entry: {
      description: "Remove an entry from a topic or MEMORY.md. Prefer replace over remove for supersessions.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string" },
          entryIdOrText: { type: "string" },
        },
        required: ["topic", "entryIdOrText"],
      },
      execute: async (input) => {
        const topic = String(input.topic ?? "").trim();
        const key = String(input.entryIdOrText ?? "").trim();
        if (topic === "user") return "Refused: the slow loop MUST NOT write USER.md.";
        if (topic === "memory") {
          const r = await memoryRemove("memory", key);
          if (!r.success) return `Error: ${r.error}`;
          state.memoryOps += 1;
          return "Removed from MEMORY.md.";
        }
        const r = await removeTopicEntry(topic, key);
        if (!r.success) return `Error: ${r.error}`;
        state.topicOps += 1;
        return `Removed from topics/${topic}.`;
      },
    },
    topic_create: {
      description: "Create a new topic shard (fails if the slug already exists).",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Lower-kebab, e.g. 'gmail-workflows' or 'gmail-workflows-2'." },
          digest: { type: "string", description: "One-line summary shown in MEMORY.md's index." },
        },
        required: ["slug", "digest"],
      },
      execute: async (input) => {
        const slug = String(input.slug ?? "").trim();
        const digest = String(input.digest ?? "").trim();
        if (!slug || !digest) return "Error: slug and digest are required.";
        const r = await createTopic(slug, digest);
        if (!r.success) return `Error: ${r.error}`;
        // Add the index line to MEMORY.md so live sessions see it.
        await memoryAdd("memory", `- ${slug}: ${digest}`).catch(() => undefined);
        state.topicOps += 1;
        return `Topic "${slug}" created.`;
      },
    },
    skill_list: {
      description: "List existing skills (id, name, description, whenToUse). Always call before skill_create.",
      parameters: { type: "object", properties: {} },
      execute: async () =>
        JSON.stringify(
          (await listSkills()).map((s) => ({ id: s.id, name: s.name, description: s.description, whenToUse: s.whenToUse })),
        ),
    },
    skill_patch: {
      description:
        "Improve an existing skill: replace a unique snippet of its instructions with new text. Prefer over skill_create.",
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
        const r = await patchSkill(String(input.id), String(input.find), String(input.replace));
        if ("error" in r) return `Error: ${r.error}`;
        await touchSkill(r.id, "patch");
        state.patchedSkills.push(r.id);
        return `Patched "${r.name}".`;
      },
    },
    skill_create: {
      description:
        "Create a new CLASS-LEVEL skill. Subject to the FR-014 skill-creation gate: no existing skill covers the class AND complexity threshold AND recurrence evidence (≥ 2 episodes with matching skill-candidate tag). Include the task class in `taskClass` for the recurrence check.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string", description: "One sentence." },
          whenToUse: { type: "string" },
          content: { type: "string", description: "Step-by-step instructions." },
          taskClass: { type: "string", description: "The skill-candidate slug matched across ≥ 2 episodes." },
        },
        required: ["name", "content", "taskClass"],
      },
      execute: async (input) => {
        const taskClass = String(input.taskClass ?? "").trim();
        const name = String(input.name ?? "").trim();
        const content = String(input.content ?? "").trim();
        if (!taskClass || !name || !content) return "Error: name, content, and taskClass are required.";
        const gate = await evaluateSkillCreationGate({
          taskClass,
          name,
          description: String(input.description ?? ""),
          content,
          currentEpisode: state.currentEpisode,
        });
        if (gate) {
          state.refusedSkillCreates.push({ taskClass, reason: gate });
          logger().info(LOG, "skill_create refused", { taskClass, reason: gate });
          if (state.currentEpisode) {
            await tagSkillCandidate(state.currentEpisode.path, taskClass).catch(() => undefined);
          }
          return `Refused (gate): ${gate}. Recorded skill-candidate tag "${taskClass}" on current episode.`;
        }
        const skill = await saveSkill({
          name,
          description: String(input.description ?? ""),
          whenToUse: input.whenToUse ? String(input.whenToUse) : undefined,
          content,
          createdBy: "agent",
          score: 1,
        });
        await touchSkill(skill.id, "patch");
        state.createdSkills.push(skill.id);
        return `Created skill "${skill.name}".`;
      },
    },
    episode_tag_candidate: {
      description:
        "Record a skill-candidate tag on an episode for the recurrence gate. Defaults to the current episode when episodePath is omitted.",
      parameters: {
        type: "object",
        properties: {
          taskClass: { type: "string" },
          episodePath: { type: "string" },
        },
        required: ["taskClass"],
      },
      execute: async (input) => {
        const taskClass = String(input.taskClass ?? "").trim();
        if (!taskClass) return "Error: taskClass is required.";
        const path = String(input.episodePath ?? state.currentEpisode?.path ?? "").trim();
        if (!path) return "Error: no episode path.";
        await tagSkillCandidate(path, taskClass);
        return `Tagged "${taskClass}" on ${path}.`;
      },
    },
    episode_mark_consolidated: {
      description:
        "Finalize an episode after its operations have applied. Defaults to the current episode when episodePath is omitted.",
      parameters: {
        type: "object",
        properties: { episodePath: { type: "string" } },
      },
      execute: async (input) => {
        const path = String(input.episodePath ?? state.currentEpisode?.path ?? "").trim();
        if (!path) return "Error: no episode path.";
        await markEpisodePathConsolidated(path);
        state.markedConsolidated.push(path);
        return `Marked ${path} as consolidated.`;
      },
    },
  };
}

// ── Run driver ───────────────────────────────────────────────────────────

export interface SlowLoopRunSummary {
  ran: boolean;
  reason?: string;
  processed: number;
  memoryOps: number;
  topicOps: number;
  skillsPatched: string[];
  skillsCreated: string[];
  skillsRefused: { taskClass: string; reason: string }[];
  markedConsolidated: string[];
  archived: number;
  errors: { episodePath: string; error: string }[];
}

export async function runSlowLoop(opts: { force?: boolean } = {}): Promise<SlowLoopRunSummary> {
  const summary: SlowLoopRunSummary = {
    ran: false,
    processed: 0,
    memoryOps: 0,
    topicOps: 0,
    skillsPatched: [],
    skillsCreated: [],
    skillsRefused: [],
    markedConsolidated: [],
    archived: 0,
    errors: [],
  };

  const cfg = await getMemoryLoopsConfig();
  if (!cfg.slowLoop.enabled && !opts.force) {
    summary.reason = "slow loop disabled";
    return summary;
  }

  const pending = await listPendingEpisodes(cfg.slowLoop.batchSize);
  if (pending.length === 0) {
    // FR-010 zero-cost exit: never call the LLM when nothing is pending. Still
    // do archive maintenance — that's file movement, not an LLM call.
    summary.archived = await archiveOldEpisodes(cfg.episodeArchiveAgeDays).catch(() => 0);
    summary.reason = "no pending episodes";
    return summary;
  }

  if (!(await hasCredentials())) {
    summary.reason = "no AI provider configured";
    return summary;
  }

  const lock = await acquireLock();
  if (!lock) {
    summary.reason = "slow-loop lock held by another run";
    return summary;
  }

  const state: SlowLoopState = {
    currentEpisode: null,
    createdSkills: [],
    patchedSkills: [],
    memoryOps: 0,
    topicOps: 0,
    refusedSkillCreates: [],
    markedConsolidated: [],
  };
  const tools = buildSlowLoopTools(state);

  try {
    for (const ep of pending) {
      state.currentEpisode = ep;
      try {
        await consolidateEpisode(ep, tools);
        summary.processed += 1;
      } catch (err) {
        summary.errors.push({ episodePath: ep.path, error: (err as Error).message });
        logger().error(LOG, "episode consolidation failed", { path: ep.path, err: (err as Error).message });
      }
    }
    summary.memoryOps = state.memoryOps;
    summary.topicOps = state.topicOps;
    summary.skillsPatched = state.patchedSkills;
    summary.skillsCreated = state.createdSkills;
    summary.skillsRefused = state.refusedSkillCreates;
    summary.markedConsolidated = state.markedConsolidated;
    summary.archived = await archiveOldEpisodes(cfg.episodeArchiveAgeDays).catch(() => 0);
    summary.ran = true;
    return summary;
  } finally {
    await releaseLock(lock);
  }
}

async function consolidateEpisode(ep: Episode, tools: Record<string, LlmTool>): Promise<void> {
  const summary = renderEpisodeForPrompt(ep);
  await runToolLoop({
    system: SLOW_LOOP_SYSTEM_PROMPT,
    prompt: summary,
    tools,
    maxSteps: 12,
  });
}

function renderEpisodeForPrompt(ep: Episode): string {
  const meta = ep.meta;
  const lines: string[] = [];
  lines.push(`Episode: ${ep.path}`);
  lines.push(`Conversation: ${meta.conversationId}`);
  lines.push(`Created: ${meta.createdAt} — Updated: ${meta.updatedAt}`);
  if (meta.skillsUsed?.length) lines.push(`skillsUsed: ${meta.skillsUsed.join(", ")}`);
  if (meta.skillCandidates?.length) lines.push(`skillCandidates: ${meta.skillCandidates.join(", ")}`);
  lines.push("");
  for (const [k, v] of Object.entries(ep.sections)) {
    if (!v || !v.trim()) continue;
    lines.push(`## ${k}`);
    lines.push(v.trim());
    lines.push("");
  }
  return lines.join("\n").trim();
}

// ── Scheduler wiring ─────────────────────────────────────────────────────

let seededOnce = false;

export async function ensureSlowLoopJob(): Promise<JobDefinition> {
  registerInternalRef(SLOW_LOOP_HANDLER_REF, async () => runAsHandler());

  const cfg = await getMemoryLoopsConfig();
  const intervalHours = Math.max(1, Math.round(cfg.slowLoop.intervalSec / 3600) || 1);
  const job = await ensureSystemJob({
    id: SLOW_LOOP_JOB_ID,
    name: "Memory: Slow Loop",
    owner: "memory",
    handler: { kind: "internal", ref: SLOW_LOOP_HANDLER_REF },
    scheduleConfig: { type: "recurring", interval: intervalHours, unit: "hour" },
    readOnlyFields: ["handler"],
  });
  if (!seededOnce) {
    seededOnce = true;
    logger().info(LOG, "slow-loop job seeded", { jobId: job.id, interval: intervalHours });
  }
  return job;
}

async function runAsHandler(): Promise<HandlerRunResult> {
  const summary = await runSlowLoop();
  if (summary.errors.length > 0) {
    return {
      status: "error",
      error: summary.errors.map((e) => `${e.episodePath}: ${e.error}`).join("; "),
      output: `${summary.processed} processed; ${summary.errors.length} error(s)`,
    };
  }
  return {
    status: "success",
    output:
      summary.reason ??
      `processed=${summary.processed} memoryOps=${summary.memoryOps} topicOps=${summary.topicOps} skillsCreated=${summary.skillsCreated.length} skillsPatched=${summary.skillsPatched.length}`,
  };
}

/** Host-side existence probe on the lock file (for observability endpoints). */
export async function isLockStale(): Promise<boolean> {
  try {
    const st = await fs.stat(hostPath(LOCK_PATH));
    return Date.now() - st.mtimeMs >= LOCK_STALE_MS;
  } catch {
    return true;
  }
}
