import "server-only";
import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import * as vfs from "@/os/vfs";
import { hostPath } from "@/os/vfs";
import { logger } from "@/lib/logging";
import { runToolLoop, type LlmTool } from "@/lib/agent/llm";
import { hasCredentials } from "@/lib/agent/provider";
import { listSkills, saveSkill, patchSkill } from "@/lib/agent/skills/store";
import { touchSkill } from "@/lib/agent/skills/usage";
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
  clearConsolidateFlag,
  createTopic,
  getTopic,
  listFlaggedTopicSlugs,
  removeTopicEntry,
  replaceTopicEntry,
  setTopicDigest,
  supersedeTopicEntry,
} from "./topics";
import { readMemoryDoc, setUserPreferences } from "./agent-memory";
import { agentLockFile, MEMORIES_ROOT, safeAgentId } from "./paths";
import { getMemoryLoopsConfig } from "./config";

// Slow loop (023-per-agent-memory, spec 021 §Slow loop). Overlap-locked (per
// agent), hourly by default, exits with zero LLM cost when nothing is pending.
// It consolidates each agent's pending episodes into that agent's own memory:
// the user-preferences summary (MEMORY.md) and topic shards.

const LOG = "memory.slow-loop";

export const SLOW_LOOP_JOB_ID = "system:memory.slow-loop";
export const SLOW_LOOP_HANDLER_REF = "memory.slow-loop";

const LOCK_STALE_MS = 30 * 60 * 1000; // 30 minutes

// ── Embedded system prompt (FR-021) ───────────────────────────────────────
export const SLOW_LOOP_SYSTEM_PROMPT = [
  "You are the consolidation engine for ONE agent's memory, merging that agent's episodic memories into its long-term knowledge. Review the pending episode and extract durable lessons, patching or creating skills as appropriate.",
  "",
  "## Input",
  "You receive the agent's CURRENT user-preferences summary and topic index, followed by one pending episode (task/outcome, what worked/failed, corrections, durable lesson candidates, profile suggestions, skillsUsed, skill-candidate tags).",
  "",
  "## Output — Incremental Operations ONLY",
  "You NEVER rewrite whole topic files. Each op modifies a single entry.",
  "",
  "User preferences (a short prose summary of who the user is and what they prefer):",
  "- memory_set_preferences(text) — replace the WHOLE user-preferences summary. To add an observation, pass the current summary MERGED with the new insight (keep it short and high-signal). Profile suggestions are OBSERVATIONS — fold them in cautiously.",
  "",
  "Topics (durable knowledge shards):",
  "- topic_create(slug, digest) — create a new topic shard when none fits (lower-kebab slug; one-line digest).",
  "- topic_add_entry(topic, content) — add an entry to a topic (creates it if missing).",
  "- topic_replace_entry(topic, entryIdOrText, newContent) — supersede a stale/contradicted entry.",
  "- topic_remove_entry(topic, entryIdOrText) — remove an entry.",
  "- topic_read(topic) — read a topic's FULL entry list (id, timestamp, text, lifecycle state), digest, and flag. Call this BEFORE reorganizing any flagged topic — the preamble below only shows you the slug + digest.",
  "- topic_set_digest(topic, digest) — refresh a topic's one-line digest after reorganizing it.",
  "- topic_supersede(topic, entryIdOrText, supersededById, supersededByTimestamp) — mark an OLDER entry superseded by a NEWER one (a detected contradiction), WITHOUT deleting it.",
  "- topic_clear_consolidate(topic) — clear a topic's consolidation flag. Call ONLY once you've finished reorganizing it (or confirmed it needs no changes) — never before, and never speculatively.",
  "",
  "Episodes:",
  "- episode_tag_candidate(taskClass) — record a skill-candidate tag on the current episode for recurrence tracking.",
  "- episode_mark_consolidated() — finalize the current episode after all its ops succeed.",
  "",
  "Skills (shared across all agents):",
  "- skill_list() — always call before creating; prefer skill_patch on an existing skill.",
  "- skill_patch(id, find, replace) — patch an existing skill; used for corrections observed on skillsUsed.",
  "- skill_create(spec) — create a NEW skill ONLY if ALL gate conditions hold (see below).",
  "",
  "## Skill Creation Gate (FR-014)",
  "A skill may be created ONLY if: (a) no existing skill covers the task class (skill_list first); (b) the task is genuinely complex (multi-step, non-obvious ordering, discovered pitfalls); (c) the same task class appears in ≥ 2 episodes. First occurrence: episode_tag_candidate; do NOT create. Second occurrence: create if (a) and (b) still hold.",
  "",
  "## Anti-Patterns (Do NOT Harden These)",
  "- Transient failures, negative tool claims, resolved errors, one-off narratives.",
  "",
  "## Holistic topic consolidation (flagged topics)",
  "Topics flagged for consolidation are listed in the preamble (soft-budget overflow or a manual request set the flag). For EACH flagged topic: topic_read it FIRST — never reorganize from the digest alone. Then reorganize using ONLY the incremental ops above; there is no whole-file rewrite op and there never will be:",
  "- Merge near-duplicate entries: topic_remove_entry the redundant ones, then topic_add_entry ONE new entry capturing the combined meaning.",
  "- Drop stale entries: topic_remove_entry. Prefer topic_supersede over remove when it's a genuine contradiction rather than staleness — the history stays visible and answerable later.",
  "- Split an over-fat topic covering more than one subject: topic_create a focused sibling, topic_add_entry each moved entry there, THEN topic_remove_entry it from the source topic. Always add-to-destination BEFORE remove-from-source — a move, never a delete-then-recreate in the other order — so an interrupted pass can never lose an entry.",
  "- Refresh the digest with topic_set_digest once the entries reflect the new organization.",
  "- If a topic is already well-organized and non-redundant, make NO changes. Gratuitous rewrites are not the goal — leaving a clean topic alone is success.",
  "- Call topic_clear_consolidate(topic) when you are done with that topic — including when you decided it needed no changes. This is what stops the scheduler from revisiting it every pass.",
  "",
  "## Contradiction detection",
  "While reading a topic (via topic_read, or while extracting a new lesson from an episode), watch for two entries on the same subject that cannot both be true (e.g. 'user works at Acme' vs 'user works at Beta', stated at different times). This is best-effort background judgment, not a hard inline rule — when you're confident you've spotted one, topic_supersede the OLDER entry, pointing it at the NEWER entry's id and timestamp. Never delete the older entry; superseding keeps it answerable for as-of queries.",
  "",
  "## Processing Order",
  "  1. Review the episode against current preferences + topics.",
  "  2. For each skillsUsed id: skill_patch when corrected, else no-change.",
  "  3. For each skill-candidate tag: check recurrence; create only if gate met.",
  "  4. Extract durable lessons → topic_add_entry to the right topic (topic_create if none fits).",
  "  5. Fold profile suggestions into memory_set_preferences.",
  "  6. episode_mark_consolidated().",
].join("\n");

// ── Overlap lock (FR-011), per agent ──────────────────────────────────────

interface LockContent {
  pid: number;
  startedAt: number;
  batchId: string;
}

async function readLock(agentId: string): Promise<LockContent | null> {
  try {
    return JSON.parse(await vfs.readText(agentLockFile(agentId))) as LockContent;
  } catch {
    return null;
  }
}

export async function acquireLock(agentId: string): Promise<LockContent | null> {
  const existing = await readLock(agentId);
  if (existing) {
    const age = Date.now() - existing.startedAt;
    if (age < LOCK_STALE_MS) {
      logger().info(LOG, "slow-loop lock held; skipping", { agentId, holderPid: existing.pid, ageMs: age });
      return null;
    }
    logger().warn(LOG, "expiring stale slow-loop lock", { agentId, holderPid: existing.pid, ageMs: age });
  }
  const content: LockContent = { pid: process.pid, startedAt: Date.now(), batchId: randomUUID() };
  await vfs.writeText(agentLockFile(agentId), JSON.stringify(content));
  const check = await readLock(agentId);
  if (!check || check.batchId !== content.batchId) return null;
  return content;
}

export async function releaseLock(agentId: string, lock: LockContent): Promise<void> {
  const current = await readLock(agentId);
  if (current && current.batchId === lock.batchId) {
    await vfs.remove(agentLockFile(agentId)).catch(() => undefined);
  }
}

// ── Restricted LLM toolset (bound to one agent) ───────────────────────────

interface SlowLoopState {
  currentEpisode: Episode | null;
  createdSkills: string[];
  patchedSkills: string[];
  memoryOps: number;
  topicOps: number;
  refusedSkillCreates: { taskClass: string; reason: string }[];
  markedConsolidated: string[];
  /** Topics whose consolidation flag was cleared this run (M1/FR-007). */
  topicsReorganized: string[];
}

/** Run all three skill-creation gate checks (FR-014) for an agent. */
export async function evaluateSkillCreationGate(
  agentId: string,
  input: { taskClass: string; name: string; description?: string; content: string },
): Promise<string | null> {
  const taskClass = input.taskClass.trim();
  if (!taskClass) return "task class is required for the skill-creation gate";

  const skills = await listSkills();
  const needle = taskClass.toLowerCase();
  const overlap = skills.find((s) => {
    const hay = `${s.name} ${s.description ?? ""} ${s.whenToUse ?? ""}`.toLowerCase();
    return hay.includes(needle) || s.id.toLowerCase() === needle;
  });
  if (overlap) return `existing skill "${overlap.name}" (${overlap.id}) already covers "${taskClass}" — use skill_patch instead`;

  const body = input.content.trim();
  const stepCount = (body.match(/^\s*(?:-|\d+\.)\s+/gm) ?? []).length;
  if (body.length < 200 || stepCount < 3) {
    return `task does not meet complexity threshold — need multi-step body (≥3 steps, ≥200 chars); got ${stepCount} step(s), ${body.length} chars`;
  }

  const occurrences = await countSkillCandidateOccurrences(taskClass);
  if (occurrences < 2) return `first occurrence of task class "${taskClass}" — tag as skill-candidate and wait for recurrence`;

  return null;
}

function buildSlowLoopTools(agentId: string, state: SlowLoopState): Record<string, LlmTool> {
  return {
    memory_set_preferences: {
      description:
        "Replace the WHOLE user-preferences summary for this agent. Pass the current summary merged with any new high-signal observation. Keep it short prose (a few sentences).",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      execute: async (input) => {
        const text = String(input.text ?? "").trim();
        if (!text) return "Error: text is required.";
        await setUserPreferences(agentId, text);
        state.memoryOps += 1;
        logger().info(LOG, "op: memory_set_preferences", { agentId, chars: text.length });
        return "User preferences updated.";
      },
    },
    topic_create: {
      description: "Create a new topic shard (fails if the slug already exists).",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Lower-kebab, e.g. 'gmail-workflows'." },
          digest: { type: "string", description: "One-line description shown in the memory index." },
        },
        required: ["slug", "digest"],
      },
      execute: async (input) => {
        const slug = String(input.slug ?? "").trim();
        const digest = String(input.digest ?? "").trim();
        if (!slug || !digest) return "Error: slug and digest are required.";
        const r = await createTopic(agentId, slug, digest);
        if (!r.success) {
          // An already-existing topic is not a failure: the model's intent is
          // just for the topic to exist so it can add entries. Treat it as a
          // soft, in-band nudge toward topic_add_entry — don't log an ERROR or
          // return "Error:" (which the model would otherwise try to "fix").
          if (/already exists/i.test(r.error ?? "")) {
            logger().info(LOG, "op: topic_create (already exists)", { agentId, slug });
            return `Topic "${slug}" already exists — use topic_add_entry to add to it.`;
          }
          logger().error(LOG, "topic_create failed", undefined, { agentId, slug, error: r.error });
          return `Error: ${r.error}`;
        }
        state.topicOps += 1;
        logger().info(LOG, "op: topic_create", { agentId, slug, digest });
        return `Topic "${slug}" created.`;
      },
    },
    topic_add_entry: {
      description: "Add an entry to a topic (creates the topic if missing). Duplicates are dropped silently.",
      parameters: {
        type: "object",
        properties: { topic: { type: "string" }, content: { type: "string" } },
        required: ["topic", "content"],
      },
      execute: async (input) => {
        const topic = String(input.topic ?? "").trim();
        const content = String(input.content ?? "").trim();
        if (!topic || !content) return "Error: topic and content are required.";
        const r = await addTopicEntry(agentId, topic, content);
        if (!r.success) {
          logger().error(LOG, "topic_add_entry failed", undefined, { agentId, topic, error: r.error });
          return `Error: ${r.error}`;
        }
        state.topicOps += 1;
        logger().info(LOG, "op: topic_add_entry", { agentId, topic, preview: content.slice(0, 100) });
        return `Added to topics/${topic} (${r.usage}).`;
      },
    },
    topic_replace_entry: {
      description: "Supersede a topic entry. Provide an entry id OR a unique substring of the old entry text.",
      parameters: {
        type: "object",
        properties: { topic: { type: "string" }, entryIdOrText: { type: "string" }, newContent: { type: "string" } },
        required: ["topic", "entryIdOrText", "newContent"],
      },
      execute: async (input) => {
        const topic = String(input.topic ?? "").trim();
        const key = String(input.entryIdOrText ?? "").trim();
        const newContent = String(input.newContent ?? "").trim();
        if (!topic || !key || !newContent) return "Error: topic, entryIdOrText, and newContent are required.";
        const r = await replaceTopicEntry(agentId, topic, key, newContent);
        if (!r.success) {
          logger().error(LOG, "topic_replace_entry failed", undefined, { agentId, topic, error: r.error });
          return `Error: ${r.error}`;
        }
        state.topicOps += 1;
        logger().info(LOG, "op: topic_replace_entry", { agentId, topic, key: key.slice(0, 60) });
        return `Replaced in topics/${topic}.`;
      },
    },
    topic_remove_entry: {
      description: "Remove an entry from a topic. Prefer replace over remove for supersessions.",
      parameters: {
        type: "object",
        properties: { topic: { type: "string" }, entryIdOrText: { type: "string" } },
        required: ["topic", "entryIdOrText"],
      },
      execute: async (input) => {
        const topic = String(input.topic ?? "").trim();
        const key = String(input.entryIdOrText ?? "").trim();
        if (!topic || !key) return "Error: topic and entryIdOrText are required.";
        const r = await removeTopicEntry(agentId, topic, key);
        if (!r.success) {
          logger().error(LOG, "topic_remove_entry failed", undefined, { agentId, topic, error: r.error });
          return `Error: ${r.error}`;
        }
        state.topicOps += 1;
        logger().info(LOG, "op: topic_remove_entry", { agentId, topic, key: key.slice(0, 60) });
        return `Removed from topics/${topic}.`;
      },
    },
    topic_read: {
      description: "Read a topic's FULL entry list (id, timestamp, text, lifecycle state, supersededBy), plus its digest and consolidation flag. Call this before reorganizing any flagged topic.",
      parameters: {
        type: "object",
        properties: { topic: { type: "string" } },
        required: ["topic"],
      },
      execute: async (input) => {
        const topic = String(input.topic ?? "").trim();
        if (!topic) return "Error: topic is required.";
        const t = await getTopic(agentId, topic);
        if (!t) return `Error: topic "${topic}" does not exist.`;
        return JSON.stringify(
          {
            slug: t.slug,
            digest: t.digest,
            consolidate: !!t.consolidate,
            entries: t.entries.map((e) => ({
              id: e.id,
              timestamp: e.timestamp,
              text: e.text,
              state: e.state ?? "active",
              supersededBy: e.supersededBy,
            })),
          },
          null,
          2,
        );
      },
    },
    topic_set_digest: {
      description: "Refresh a topic's one-line digest, e.g. after merging/splitting its entries.",
      parameters: {
        type: "object",
        properties: { topic: { type: "string" }, digest: { type: "string" } },
        required: ["topic", "digest"],
      },
      execute: async (input) => {
        const topic = String(input.topic ?? "").trim();
        const digest = String(input.digest ?? "").trim();
        if (!topic || !digest) return "Error: topic and digest are required.";
        const r = await setTopicDigest(agentId, topic, digest);
        if (!r.success) {
          logger().error(LOG, "topic_set_digest failed", undefined, { agentId, topic, error: r.error });
          return `Error: ${r.error}`;
        }
        state.topicOps += 1;
        logger().info(LOG, "op: topic_set_digest", { agentId, topic });
        return `Digest updated for topics/${topic}.`;
      },
    },
    topic_supersede: {
      description:
        "Mark an OLDER entry as superseded by a NEWER one (a detected contradiction) WITHOUT deleting it. Provide the older entry's id/text and the newer entry's id + timestamp as the reference.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string" },
          entryIdOrText: { type: "string", description: "The OLDER entry to mark superseded." },
          supersededById: { type: "string", description: "The id of the NEWER entry that supersedes it." },
          supersededByTimestamp: { type: "string", description: "The newer entry's yyyy-mm-dd timestamp." },
        },
        required: ["topic", "entryIdOrText", "supersededById", "supersededByTimestamp"],
      },
      execute: async (input) => {
        const topic = String(input.topic ?? "").trim();
        const key = String(input.entryIdOrText ?? "").trim();
        const supersededById = String(input.supersededById ?? "").trim();
        const supersededByTimestamp = String(input.supersededByTimestamp ?? "").trim();
        if (!topic || !key || !supersededById || !supersededByTimestamp) {
          return "Error: topic, entryIdOrText, supersededById, and supersededByTimestamp are required.";
        }
        const r = await supersedeTopicEntry(agentId, topic, key, { id: supersededById, timestamp: supersededByTimestamp });
        if (!r.success) {
          logger().error(LOG, "topic_supersede failed", undefined, { agentId, topic, error: r.error });
          return `Error: ${r.error}`;
        }
        state.topicOps += 1;
        logger().info(LOG, "op: topic_supersede", { agentId, topic, key: key.slice(0, 60) });
        return `Marked entry superseded in topics/${topic}.`;
      },
    },
    topic_clear_consolidate: {
      description:
        "Clear a topic's consolidation flag. Call ONLY after you've finished reorganizing it (or confirmed it already needs no changes) — never before, and never speculatively.",
      parameters: {
        type: "object",
        properties: { topic: { type: "string" } },
        required: ["topic"],
      },
      execute: async (input) => {
        const topic = String(input.topic ?? "").trim();
        if (!topic) return "Error: topic is required.";
        const r = await clearConsolidateFlag(agentId, topic);
        if (!r.success) {
          logger().error(LOG, "topic_clear_consolidate failed", undefined, { agentId, topic, error: r.error });
          return `Error: ${r.error}`;
        }
        state.topicsReorganized.push(topic);
        logger().info(LOG, "op: topic_clear_consolidate", { agentId, topic });
        return `Cleared the consolidation flag on topics/${topic}.`;
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
      description: "Improve an existing skill: replace a unique snippet of its instructions with new text. Prefer over skill_create.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, find: { type: "string" }, replace: { type: "string" } },
        required: ["id", "find", "replace"],
      },
      execute: async (input) => {
        const r = await patchSkill(String(input.id), String(input.find), String(input.replace));
        if ("error" in r) {
          logger().error(LOG, "skill_patch failed", undefined, { id: input.id, error: r.error });
          return `Error: ${r.error}`;
        }
        await touchSkill(r.id, "patch");
        state.patchedSkills.push(r.id);
        logger().info(LOG, "op: skill_patch", { id: r.id, name: r.name });
        return `Patched "${r.name}".`;
      },
    },
    skill_create: {
      description:
        "Create a new CLASS-LEVEL skill. Subject to the FR-014 gate: no existing skill covers the class AND complexity threshold AND recurrence evidence (≥ 2 episodes with matching skill-candidate tag). Include the task class in `taskClass`.",
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
        const gate = await evaluateSkillCreationGate(agentId, {
          taskClass,
          name,
          description: String(input.description ?? ""),
          content,
        });
        if (gate) {
          state.refusedSkillCreates.push({ taskClass, reason: gate });
          logger().info(LOG, "skill_create refused", { agentId, taskClass, reason: gate });
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
        logger().info(LOG, "op: skill_create", { agentId, id: skill.id, name: skill.name, taskClass });
        return `Created skill "${skill.name}".`;
      },
    },
    episode_tag_candidate: {
      description: "Record a skill-candidate tag on the current episode for the recurrence gate.",
      parameters: {
        type: "object",
        properties: { taskClass: { type: "string" }, episodePath: { type: "string" } },
        required: ["taskClass"],
      },
      execute: async (input) => {
        const taskClass = String(input.taskClass ?? "").trim();
        if (!taskClass) return "Error: taskClass is required.";
        const path = String(input.episodePath ?? state.currentEpisode?.path ?? "").trim();
        if (!path) return "Error: no episode path.";
        await tagSkillCandidate(path, taskClass);
        logger().info(LOG, "op: episode_tag_candidate", { agentId, taskClass, path });
        return `Tagged "${taskClass}".`;
      },
    },
    episode_mark_consolidated: {
      description: "Finalize the current episode after its operations have applied.",
      parameters: { type: "object", properties: { episodePath: { type: "string" } } },
      execute: async (input) => {
        const path = String(input.episodePath ?? state.currentEpisode?.path ?? "").trim();
        if (!path) return "Error: no episode path.";
        await markEpisodePathConsolidated(path);
        state.markedConsolidated.push(path);
        logger().info(LOG, "op: episode_mark_consolidated", { agentId, path });
        return `Marked ${path} as consolidated.`;
      },
    },
  };
}

// ── Run driver ───────────────────────────────────────────────────────────

export interface SlowLoopRunSummary {
  ran: boolean;
  reason?: string;
  /** Agent ids that had episodes consolidated this run. */
  agents: string[];
  processed: number;
  memoryOps: number;
  topicOps: number;
  skillsPatched: string[];
  skillsCreated: string[];
  skillsRefused: { taskClass: string; reason: string }[];
  markedConsolidated: string[];
  /** Topics whose consolidation flag was cleared this run (M1/FR-007). */
  topicsReorganized: string[];
  archived: number;
  errors: { agentId: string; episodePath: string; error: string }[];
}

function emptySummary(): SlowLoopRunSummary {
  return {
    ran: false,
    agents: [],
    processed: 0,
    memoryOps: 0,
    topicOps: 0,
    skillsPatched: [],
    skillsCreated: [],
    skillsRefused: [],
    markedConsolidated: [],
    topicsReorganized: [],
    archived: 0,
    errors: [],
  };
}

/** List agent ids that have a memory directory under /Memories. */
async function listAgentsWithMemory(): Promise<string[]> {
  try {
    const entries = await vfs.list(MEMORIES_ROOT);
    return entries.filter((e) => e.type === "dir").map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function runSlowLoop(opts: { force?: boolean; onlyAgentId?: string } = {}): Promise<SlowLoopRunSummary> {
  const summary = emptySummary();

  const cfg = await getMemoryLoopsConfig();
  if (!cfg.slowLoop.enabled && !opts.force) {
    logger().info(LOG, "slow loop disabled; skipping");
    summary.reason = "slow loop disabled";
    return summary;
  }

  const agentIds = opts.onlyAgentId ? [safeAgentId(opts.onlyAgentId)] : await listAgentsWithMemory();
  if (agentIds.length === 0) {
    summary.reason = "no agent memory found";
    return summary;
  }

  let anyPending = false;
  let hasCreds: boolean | null = null;

  for (const agentId of agentIds) {
    const pending = await listPendingEpisodes(agentId, cfg.slowLoop.batchSize);
    // M1 fix: a topic flagged by a soft-budget overflow creates NO episode, so
    // gating on pending episodes alone would skip it forever. Run a pass when
    // there are pending episodes OR at least one flagged topic.
    const flagged = await listFlaggedTopicSlugs(agentId);
    if (pending.length === 0 && flagged.length === 0) {
      summary.archived += await archiveOldEpisodes(agentId, cfg.episodeArchiveAgeDays).catch(() => 0);
      continue;
    }
    anyPending = true;
    if (hasCreds === null) hasCreds = await hasCredentials();
    if (!hasCreds) {
      logger().warn(LOG, "slow loop: no AI credentials configured — cannot run", { agentId, pending: pending.length, flagged: flagged.length });
      summary.reason = "no AI provider configured";
      continue;
    }
    await consolidateAgent(agentId, pending, cfg, summary);
  }

  summary.ran = true;
  if (!anyPending && !summary.reason) summary.reason = "no pending episodes";
  logger().info(LOG, "slow loop run", {
    agents: summary.agents.length,
    processed: summary.processed,
    memoryOps: summary.memoryOps,
    topicOps: summary.topicOps,
    skillsPatched: summary.skillsPatched.length,
    skillsCreated: summary.skillsCreated.length,
    skillsRefused: summary.skillsRefused.length,
    topicsReorganized: summary.topicsReorganized.length,
    archived: summary.archived,
    errors: summary.errors.length,
  });
  return summary;
}

async function consolidateAgent(
  agentId: string,
  pending: Episode[],
  cfg: Awaited<ReturnType<typeof getMemoryLoopsConfig>>,
  summary: SlowLoopRunSummary,
): Promise<void> {
  const lock = await acquireLock(agentId);
  if (!lock) return; // held by another run — try again next tick
  summary.agents.push(agentId);

  const state: SlowLoopState = {
    currentEpisode: null,
    createdSkills: [],
    patchedSkills: [],
    memoryOps: 0,
    topicOps: 0,
    refusedSkillCreates: [],
    markedConsolidated: [],
    topicsReorganized: [],
  };
  const tools = buildSlowLoopTools(agentId, state);
  const preamble = await renderAgentPreamble(agentId);

  logger().info(LOG, "slow loop starting", { agentId, pending: pending.length, batchSize: cfg.slowLoop.batchSize, batchId: lock.batchId });

  try {
    for (let i = 0; i < pending.length; i++) {
      const ep = pending[i];
      state.currentEpisode = ep;
      const convId = ep.meta.conversationId;
      logger().log({
        level: "info",
        component: LOG,
        conversation: convId,
        msg: "consolidating episode",
        data: { agentId, path: ep.path, index: i + 1, total: pending.length },
      });
      try {
        await consolidateEpisode(ep, tools, preamble);
        if (!state.markedConsolidated.includes(ep.path)) {
          logger().log({
            level: "warn",
            component: LOG,
            conversation: convId,
            msg: "LLM did not call episode_mark_consolidated — auto-marking",
            data: { agentId, path: ep.path },
          });
          await markEpisodePathConsolidated(ep.path).catch((e) => {
            const err = e instanceof Error ? { message: e.message, stack: e.stack } : { message: String(e) };
            logger().log({ level: "error", component: LOG, conversation: convId, msg: "auto-mark consolidated failed", err, data: { agentId, path: ep.path } });
          });
          state.markedConsolidated.push(ep.path);
        }
        summary.processed += 1;
      } catch (err) {
        summary.errors.push({ agentId, episodePath: ep.path, error: (err as Error).message });
        const e = err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) };
        logger().log({ level: "error", component: LOG, conversation: convId, msg: "episode consolidation failed", err: e, data: { agentId, path: ep.path } });
      }
    }
    // M1: re-derive the flagged set now — episode consolidation above may have
    // just flagged a topic (a topic_add_entry that overflowed the budget), and
    // this is the same pass that should reorganize it, not next hour's.
    const flaggedTopics = await listFlaggedTopicSlugs(agentId);
    for (const slug of flaggedTopics) {
      logger().info(LOG, "consolidating flagged topic", { agentId, slug });
      try {
        await consolidateFlaggedTopic(agentId, slug, tools, preamble);
      } catch (err) {
        summary.errors.push({ agentId, episodePath: `topic:${slug}`, error: (err as Error).message });
        const e = err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) };
        logger().log({ level: "error", component: LOG, msg: "flagged-topic consolidation failed", err: e, data: { agentId, slug } });
      }
    }

    summary.memoryOps += state.memoryOps;
    summary.topicOps += state.topicOps;
    summary.skillsPatched.push(...state.patchedSkills);
    summary.skillsCreated.push(...state.createdSkills);
    summary.skillsRefused.push(...state.refusedSkillCreates);
    summary.markedConsolidated.push(...state.markedConsolidated);
    summary.topicsReorganized.push(...state.topicsReorganized);
    summary.archived += await archiveOldEpisodes(agentId, cfg.episodeArchiveAgeDays).catch(() => 0);
  } finally {
    await releaseLock(agentId, lock);
  }
}

async function renderAgentPreamble(agentId: string): Promise<string> {
  const doc = await readMemoryDoc(agentId);
  const prefs = doc.preferences ? doc.preferences : "_(none recorded yet)_";
  const topics = doc.index.length
    ? doc.index.map((r) => `- ${r.file.replace(/^Topics\//, "").replace(/\.md$/, "")}: ${r.description}`).join("\n")
    : "_(no topics yet)_";
  const flagged = await listFlaggedTopicSlugs(agentId);
  const flaggedBlock = flagged.length
    ? `\n\nTopics FLAGGED for consolidation (topic_read + reorganize each; topic_clear_consolidate when done):\n${flagged
        .map((s) => `- ${s}`)
        .join("\n")}`
    : "";
  return [`This agent's CURRENT user preferences:`, prefs, "", `This agent's EXISTING topics (slug — digest):`, topics + flaggedBlock].join("\n");
}

async function consolidateEpisode(ep: Episode, tools: Record<string, LlmTool>, preamble: string): Promise<void> {
  const prompt = `${preamble}\n\n---\n\nPending episode to consolidate:\n\n${renderEpisodeForPrompt(ep)}`;
  await runToolLoop({ system: SLOW_LOOP_SYSTEM_PROMPT, prompt, tools, maxSteps: 12, correlationId: ep.meta.conversationId });
}

/** Reorganize ONE flagged topic (M1/T1): a dedicated tool-loop pass, independent
 *  of any episode, so a topic flagged purely by a soft-budget overflow (which
 *  creates no episode) still gets processed. */
async function consolidateFlaggedTopic(
  agentId: string,
  slug: string,
  tools: Record<string, LlmTool>,
  preamble: string,
): Promise<void> {
  const prompt = [
    preamble,
    "",
    "---",
    "",
    `Topic "${slug}" is flagged for consolidation (soft-budget overflow, or a manual request). Call topic_read("${slug}") FIRST to see its full entry list — do not reorganize from the digest alone.`,
    "Then reorganize it per the Holistic topic consolidation guidance above, and refresh its digest if the entries changed.",
    `Finish by calling topic_clear_consolidate("${slug}") — including if you decided the topic needed no changes.`,
  ].join("\n");
  await runToolLoop({ system: SLOW_LOOP_SYSTEM_PROMPT, prompt, tools, maxSteps: 16, correlationId: `topic:${agentId}:${slug}` });
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
      error: summary.errors.map((e) => `${e.agentId}/${e.episodePath}: ${e.error}`).join("; "),
      output: `${summary.processed} processed; ${summary.errors.length} error(s)`,
    };
  }
  return {
    status: "success",
    output:
      summary.reason ??
      `agents=${summary.agents.length} processed=${summary.processed} memoryOps=${summary.memoryOps} topicOps=${summary.topicOps} skillsCreated=${summary.skillsCreated.length} skillsPatched=${summary.skillsPatched.length} topicsReorganized=${summary.topicsReorganized.length}`,
  };
}

/** Host-side existence probe on an agent's lock file (for observability). */
export async function isLockStale(agentId: string): Promise<boolean> {
  try {
    const st = await fs.stat(hostPath(agentLockFile(agentId)));
    return Date.now() - st.mtimeMs >= LOCK_STALE_MS;
  } catch {
    return true;
  }
}
