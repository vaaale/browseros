import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import type { Agent, AgentType } from "./types";
import { parseFrontmatter, buildFrontmatter, asString, asList, asBool } from "./markdown";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";
import { CAPABILITIES } from "@/lib/agent/capabilities-registry";
import { reconcileInstalledItemAssets } from "@/system/marketplace/install/bundledAssets";
import { archiveSeededDir, decideSeedAction, readSeedStamp, seedRev, writeSeedStamp } from "@/lib/agent/seed-sync";

/** Resolved per call, NOT captured at module scope. `dataDir()` is env-driven
 *  (`BOS_DATA_DIR`) and BOS changes it at runtime — a feature-branch data clone
 *  and a per-user container both point it elsewhere — so a module-scope constant
 *  serves whatever path was current the first time this module was imported. */
function agentsDir(): string {
  return path.join(dataDir(), "agents");
}
/** Agents moved aside by seed reconciliation (never deleted) — see seed-sync.ts. */
const ARCHIVE_DIR = path.join(agentsDir(), ".archive");

// Folder id of the shared "default prompt" template. Not a runnable agent — its
// body is prepended to any agent whose useDefaultPrompt is true. Managed via
// Settings → Agents → Default Agent; filtered out of the normal agent list.
export const DEFAULT_PROMPT_AGENT_ID = "default_agent";

// Root of the seed directory. Each subfolder contains an AGENT.md that is
// copied into data/agents/. Reconciled rather than merely backfilled: a copy
// BOS wrote and nobody has edited since tracks the seed (updated in place, or
// archived when the seed drops the id); anything locally edited is left alone.
// See seed-sync.ts for the .seed-rev mechanism and its one-time migration cost.
const SEED_DIR = path.join(process.cwd(), "seed", "agents");

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `agent-${Date.now().toString(36)}`;
}

// ── Seed loading ─────────────────────────────────────────────────────────────

/** Returns all agent ids present in the seed directory. */
async function listSeedIds(): Promise<string[]> {
  const entries = await fs.readdir(SEED_DIR, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/**
 * Reconcile one seed agent into data/agents/: write it when absent, refresh it
 * when BOS's own copy is untouched and the seed has moved on, and never touch a
 * locally edited one (Settings → Agents edits, capability changes, and the
 * allowlist backfills below all count as edits, which is the point).
 */
async function applySeedAgent(id: string): Promise<string | null> {
  const seedRaw = await fs.readFile(path.join(SEED_DIR, id, "AGENT.md"), "utf8").catch(() => null);
  if (seedRaw === null) return null;
  const dir = path.join(agentsDir(), id);
  const liveRaw = await fs.readFile(path.join(dir, "AGENT.md"), "utf8").catch(() => null);
  const action = decideSeedAction({
    inSeed: true,
    liveRev: liveRaw === null ? undefined : seedRev([liveRaw]),
    stamp: await readSeedStamp(dir),
    seedRev: seedRev([seedRaw]),
  });
  if (action !== "seed" && action !== "update") return null;
  await fs.mkdir(dir, { recursive: true });
  await writeFileAtomic(path.join(dir, "AGENT.md"), seedRaw);
  // Refreshing an agent restores the seed's own frontmatter, which carries no
  // tool allowlist — so the backfills below must run over it again, and their
  // per-agent marker (which exists to make them one-shot) has to go with it.
  // Without this an updated agent would come back with an EMPTY allowlist, and
  // under `empty allowlist = zero tools` that is a silently mute agent.
  if (action === "update") {
    await fs.rm(path.join(dir, MIGRATION_MARKER), { force: true });
    await fs.rm(path.join(dir, CONFLICT_BACKFILL_MARKER), { force: true });
  }
  return id;
}

/**
 * Stamp the agents just written, AFTER the migrations that rewrite them. The
 * `live` half of the stamp must describe the final bytes on disk, not what
 * `applySeedAgent` wrote — otherwise every seeded agent reads as locally
 * modified on the next boot and nothing ever updates again.
 */
async function stampSeededAgents(ids: string[]): Promise<void> {
  for (const id of ids) {
    const dir = path.join(agentsDir(), id);
    const [seedRaw, liveRaw] = await Promise.all([
      fs.readFile(path.join(SEED_DIR, id, "AGENT.md"), "utf8").catch(() => null),
      fs.readFile(path.join(dir, "AGENT.md"), "utf8").catch(() => null),
    ]);
    if (seedRaw === null || liveRaw === null) continue;
    await writeSeedStamp(dir, { seed: seedRev([seedRaw]), live: seedRev([liveRaw]) });
  }
}

/**
 * Archive agents BOS seeded that the seed no longer ships — the deletion half
 * of reconciliation. Only ever touches a copy that is provably still BOS's own
 * (stamped and unedited); anything the user made theirs stays.
 */
async function archiveDroppedSeedAgents(seedIds: string[]): Promise<void> {
  // An unreadable or empty seed directory must never read as "everything was
  // deleted" — that would archive the whole agent set on a broken deployment.
  if (seedIds.length === 0) return;
  const shipped = new Set(seedIds);
  const entries = await fs.readdir(agentsDir(), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (shipped.has(entry.name) || isProtectedAgentId(entry.name)) continue;
    const dir = path.join(agentsDir(), entry.name);
    const liveRaw = await fs.readFile(path.join(dir, "AGENT.md"), "utf8").catch(() => null);
    const action = decideSeedAction({
      inSeed: false,
      liveRev: liveRaw === null ? undefined : seedRev([liveRaw]),
      stamp: await readSeedStamp(dir),
    });
    if (action === "archive") await archiveSeededDir(dir, ARCHIVE_DIR, entry.name);
  }
}

function toMarkdown(a: Agent): string {
  return buildFrontmatter(
    {
      name: a.name,
      description: a.description,
      type: a.type,
      model: a.model,
      subagent_type: a.subagentType,
      tools: a.tools,
      skills: a.skills,
      mcp: a.mcp,
      kbs: a.kbs,
      deferredTools: a.deferredTools,
      useDefaultPrompt: a.useDefaultPrompt,
    },
    a.systemPrompt,
  );
}

function fromMarkdown(id: string, src: string): Agent {
  const { meta, body } = parseFrontmatter(src);
  const type = (asString(meta.type) === "claude" ? "claude" : "local") as AgentType;
  return {
    id,
    name: asString(meta.name) || id,
    description: asString(meta.description) || "",
    type,
    systemPrompt: body,
    tools: asList(meta.tools),
    skills: asList(meta.skills),
    mcp: asList(meta.mcp),
    kbs: asList(meta.kbs),
    deferredTools: asList(meta.deferredTools),
    useDefaultPrompt: asBool(meta.useDefaultPrompt),
    model: asString(meta.model),
    subagentType: asString(meta.subagent_type),
  };
}


// Tracked PER DATA ROOT, not per process. `dataDir()` is env-driven and BOS
// changes it at runtime (a feature-branch data clone, a per-user container), so
// a single boolean meant only the FIRST root ever got seeded — after switching
// roots, the seeded agents/skills would silently never appear there.
const seededRoots = new Set<string>();
async function ensureSeed(): Promise<void> {
  const root = agentsDir();
  if (seededRoots.has(root)) return;
  seededRoots.add(root);
  await fs.mkdir(root, { recursive: true });
  // Reconcile every seed agent (including default_agent): seed what's missing,
  // refresh what BOS wrote and nobody edited, archive what the seed dropped.
  // A locally edited agent is never written to — user edits always win.
  const seedIds = await listSeedIds();
  const written: string[] = [];
  for (const id of seedIds) {
    const wrote = await applySeedAgent(id);
    if (wrote) written.push(wrote);
  }
  await archiveDroppedSeedAgents(seedIds);
  // Marketplace items may bundle their own agents (040-okf-knowledge-base).
  // Reconciled here, not only at install time, because an already-installed
  // item that gains an agent would otherwise never surface it — nobody
  // reinstalls an item they already have. Same additive contract as the seed
  // agents above: never overwrites a locally-modified copy.
  await reconcileInstalledItemAssets();
  // Phase B strict-allowlist migration: with `empty allowlist = zero tools`,
  // any legacy agent that relied on "unset ⇒ all" would silently lose every
  // tool on upgrade. Backfill each such agent's allowlist with the FULL set
  // of capability ids the ONE TIME they're first read on the new code. The
  // per-agent marker file makes this idempotent — a user who later saves an
  // explicit empty allowlist will keep it (the marker prevents re-migration).
  await backfillLegacyAllowlists();
  // 035: a pre-existing data/agents/devops/AGENT.md (from any prior install)
  // is never re-seeded — applySeedAgent returns early when the destination
  // exists — so it would silently lack the conflict_* tools and every
  // escalation would fail at the first tool call. Backfill the ids explicitly.
  await backfillConflictTools();
  // LAST: the two backfills above rewrite the files applySeedAgent just wrote,
  // so the stamp has to describe the bytes that ended up on disk. Stamping any
  // earlier makes every seeded agent look locally edited on the next boot.
  await stampSeededAgents(written);
}

/** Tool ids the conflict-resolution pipeline needs (035). */
const CONFLICT_TOOL_IDS = [
  "conflict_read",
  "conflict_write",
  "conflict_decision",
  "conflict_status",
  "conflict_complete",
  "conflict_abandon",
] as const;
const CONFLICT_BACKFILL_MARKER = ".conflict-tools-backfilled";

/** Additive, idempotent, and marker-guarded, exactly like the allowlist
 *  migration above: a user who later removes these ids keeps them removed. */
async function backfillConflictTools(): Promise<void> {
  const agentDir = path.join(agentsDir(), "devops");
  const marker = path.join(agentDir, CONFLICT_BACKFILL_MARKER);
  try {
    await fs.access(marker);
    return;
  } catch { /* not backfilled yet */ }

  const file = path.join(agentDir, "AGENT.md");
  let src: string;
  try {
    src = await fs.readFile(file, "utf8");
  } catch {
    return; // no devops agent on this install — the seed will bring the new one
  }
  const agent = fromMarkdown("devops", src);
  const missing = CONFLICT_TOOL_IDS.filter((id) => !agent.tools?.includes(id));
  if (missing.length > 0) {
    await writeFileAtomic(file, toMarkdown({ ...agent, tools: [...missing, ...(agent.tools ?? [])] }));
  }
  await writeFileAtomic(marker, "1").catch(() => undefined);
}

// One-time backfill executed at first read after upgrade. Uses a per-agent
// marker file (.capabilities-migrated) instead of a frontmatter field so the
// Agent schema stays clean.
const MIGRATION_MARKER = ".capabilities-migrated";
const ALL_CAPABILITY_IDS: string[] = CAPABILITIES.map((c) => c.id);

async function backfillLegacyAllowlists(): Promise<void> {
  const entries = await fs.readdir(agentsDir(), { withFileTypes: true }).catch(() => [] as import("fs").Dirent[]);
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    if (d.name === DEFAULT_PROMPT_AGENT_ID) continue;
    const agentDir = path.join(agentsDir(), d.name);
    const marker = path.join(agentDir, MIGRATION_MARKER);
    try {
      await fs.access(marker);
      continue; // already migrated
    } catch { /* not migrated yet */ }

    const file = path.join(agentDir, "AGENT.md");
    let src: string;
    try {
      src = await fs.readFile(file, "utf8");
    } catch {
      continue; // no AGENT.md — skip
    }
    const agent = fromMarkdown(d.name, src);
    if (!agent.tools || agent.tools.length === 0) {
      const updated: Agent = { ...agent, tools: [...ALL_CAPABILITY_IDS] };
      await writeFileAtomic(file, toMarkdown(updated));
    }
    // Marker written regardless — a user who deliberately saves an empty
    // allowlist after this point should not be re-migrated.
    await writeFileAtomic(marker, "1");
  }
}


export async function listSubAgents(): Promise<Agent[]> {
  await ensureSeed();
  const dirs = await fs.readdir(agentsDir(), { withFileTypes: true }).catch(() => []);
  const agents: Agent[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    // `.archive/` holds agents seed reconciliation moved aside — not agents.
    if (d.name.startsWith(".")) continue;
    if (d.name === DEFAULT_PROMPT_AGENT_ID) continue;
    try {
      const src = await fs.readFile(path.join(agentsDir(), d.name, "AGENT.md"), "utf8");
      agents.push(fromMarkdown(d.name, src));
    } catch {
      /* skip dirs without AGENT.md */
    }
  }
  return agents;
}

/** The shared default-prompt template (its body is prepended to agents whose
 *  useDefaultPrompt is true). Read and edited only via Settings → Agents →
 *  Default Agent — NOT surfaced by listSubAgents. */
export async function getDefaultPromptAgent(): Promise<Agent | undefined> {
  await ensureSeed();
  try {
    const src = await fs.readFile(path.join(agentsDir(), DEFAULT_PROMPT_AGENT_ID, "AGENT.md"), "utf8");
    return fromMarkdown(DEFAULT_PROMPT_AGENT_ID, src);
  } catch {
    return undefined;
  }
}

/** Rewrite the shared default-prompt template's body (and optionally its meta).
 *  Kept minimal: the template is a body-first document — description is the only
 *  frontmatter a user might reasonably want to edit. */
export async function setDefaultPromptAgent(input: { systemPrompt: string; description?: string }): Promise<Agent> {
  await ensureSeed();
  const existing = await getDefaultPromptAgent();
  const updated: Agent = {
    id: DEFAULT_PROMPT_AGENT_ID,
    name: existing?.name || "Default",
    description: input.description ?? existing?.description ?? "Shared default prompt.",
    type: "local",
    systemPrompt: input.systemPrompt,
  };
  await fs.mkdir(path.join(agentsDir(), DEFAULT_PROMPT_AGENT_ID), { recursive: true });
  await writeFileAtomic(path.join(agentsDir(), DEFAULT_PROMPT_AGENT_ID, "AGENT.md"), toMarkdown(updated));
  return updated;
}

export async function getAgent(idOrName: string): Promise<Agent | undefined> {
  const key = idOrName.toLowerCase();
  return (await listSubAgents()).find((a) => a.id.toLowerCase() === key || a.name.toLowerCase() === key);
}

export async function createSubAgent(input: {
  name: string;
  description: string;
  type?: AgentType;
  systemPrompt: string;
  tools?: string[];
  model?: string;
  subagentType?: string;
}): Promise<Agent> {
  await ensureSeed();
  const id = slugify(input.name);
  // Under Phase B, empty/missing tools means ZERO tools. New agents created
  // without an explicit tools list would otherwise land with no capabilities,
  // which is not the intent — mirror the migration by defaulting to the full
  // capability set. Callers that want a locked-down agent should pass tools: [].
  const tools = input.tools ?? [...ALL_CAPABILITY_IDS];
  const agent: Agent = { id, type: input.type ?? "local", ...input, tools };
  await fs.mkdir(path.join(agentsDir(), id), { recursive: true });
  await writeFileAtomic(path.join(agentsDir(), id, "AGENT.md"), toMarkdown(agent));
  // Mark migrated so ensureSeed doesn't try to re-backfill this agent.
  await writeFileAtomic(path.join(agentsDir(), id, MIGRATION_MARKER), "1");
  return agent;
}

export async function removeSubAgent(idOrName: string): Promise<void> {
  const agent = await getAgent(idOrName);
  if (agent) await fs.rm(path.join(agentsDir(), agent.id), { recursive: true, force: true });
}

// NOTE: there is deliberately no global "active agent". Each conversation carries
// its own agent id (per-conversation), which is the ONLY source of truth. Agent
// resolution for a request requires that explicit id (see composeInstructions) —
// there is no mutable global to fall back to.

/** Replace an agent's system prompt (its instructions/personality), preserving its metadata. */
export async function setAgentSystemPrompt(id: string, systemPrompt: string): Promise<Agent | undefined> {
  const agent = await getAgent(id);
  if (!agent) return undefined;
  const updated: Agent = { ...agent, systemPrompt };
  await writeFileAtomic(path.join(agentsDir(), agent.id, "AGENT.md"), toMarkdown(updated));
  return updated;
}

/** Update an agent's capability allowlists (tools/skills/mcp/kbs/deferredTools).
 *  Only provided classes are changed. Tools use the strict allowlist migrated
 *  above; skills/MCP/kbs keep their unset/empty-means-all behavior; deferredTools
 *  is the agent's sole (no registry-wide default) deferred-tool list. */
export async function setAgentCapabilities(
  id: string,
  caps: { tools?: string[]; skills?: string[]; mcp?: string[]; kbs?: string[]; deferredTools?: string[] },
): Promise<Agent | undefined> {
  const agent = await getAgent(id);
  if (!agent) return undefined;
  const updated: Agent = {
    ...agent,
    tools: caps.tools ?? agent.tools,
    skills: caps.skills ?? agent.skills,
    mcp: caps.mcp ?? agent.mcp,
    kbs: caps.kbs ?? agent.kbs,
    deferredTools: caps.deferredTools ?? agent.deferredTools,
  };
  await writeFileAtomic(path.join(agentsDir(), agent.id, "AGENT.md"), toMarkdown(updated));
  return updated;
}

/** Toggle whether the shared default prompt (default_agent template) is
 *  prepended to this agent's personality. */
export async function setAgentUseDefaultPrompt(id: string, value: boolean): Promise<Agent | undefined> {
  const agent = await getAgent(id);
  if (!agent) return undefined;
  const updated: Agent = { ...agent, useDefaultPrompt: value };
  await writeFileAtomic(path.join(agentsDir(), agent.id, "AGENT.md"), toMarkdown(updated));
  return updated;
}

/** Update an agent's name and/or description without touching its system prompt
 *  or capability allowlists. Fields left undefined are preserved as-is. */
export async function setAgentMeta(
  id: string,
  meta: { name?: string; description?: string },
): Promise<Agent | undefined> {
  const agent = await getAgent(id);
  if (!agent) return undefined;
  const updated: Agent = {
    ...agent,
    name: typeof meta.name === "string" ? meta.name : agent.name,
    description: typeof meta.description === "string" ? meta.description : agent.description,
  };
  await writeFileAtomic(path.join(agentsDir(), agent.id, "AGENT.md"), toMarkdown(updated));
  return updated;
}

/** The default assistant agent cannot be deleted — the main chat's personality
 *  slot points at it. Callers should surface this to the user rather than trap
 *  the error. */
export class ProtectedAgentError extends Error {
  constructor(id: string) {
    super(`Agent "${id}" is protected and cannot be deleted.`);
    this.name = "ProtectedAgentError";
  }
}

export function isProtectedAgentId(id: string): boolean {
  return id === DEFAULT_AGENT_ID;
}

/** Delete a sub-agent by id, rejecting the default assistant. Resolves the
 *  id/name the same way removeSubAgent does. */
export async function deleteSubAgent(idOrName: string): Promise<void> {
  const agent = await getAgent(idOrName);
  if (!agent) return;
  if (isProtectedAgentId(agent.id)) throw new ProtectedAgentError(agent.id);
  await fs.rm(path.join(agentsDir(), agent.id), { recursive: true, force: true });
}
