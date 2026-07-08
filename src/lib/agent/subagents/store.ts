import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import type { Agent, AgentType } from "./types";
import { parseFrontmatter, buildFrontmatter, asString, asList, asBool } from "./markdown";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";
import { CAPABILITIES } from "@/lib/agent/capabilities-registry";

const DIR = path.join(dataDir(), "agents");

// Folder id of the shared "default prompt" template. Not a runnable agent — its
// body is prepended to any agent whose useDefaultPrompt is true. Managed via
// Settings → Agents → Default Agent; filtered out of the normal agent list.
export const DEFAULT_PROMPT_AGENT_ID = "default_agent";

// Root of the seed directory. Each subfolder contains an AGENT.md that is
// copied into data/agents/ on first install (additive — never overwrites edits).
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

/** Read and parse one seed AGENT.md, or return undefined if missing. */
async function readSeedAgent(id: string): Promise<Agent | undefined> {
  try {
    const src = await fs.readFile(path.join(SEED_DIR, id, "AGENT.md"), "utf8");
    return fromMarkdown(id, src);
  } catch {
    return undefined;
  }
}

/** Copy a seed agent into data/agents/ if the destination doesn't exist yet. */
async function applySeedAgent(id: string): Promise<void> {
  const dst = path.join(DIR, id, "AGENT.md");
  try { await fs.access(dst); return; } catch { /* missing — seed it */ }
  const src = await readSeedAgent(id);
  if (!src) return;
  await fs.mkdir(path.join(DIR, id), { recursive: true });
  await writeFileAtomic(dst, await fs.readFile(path.join(SEED_DIR, id, "AGENT.md"), "utf8"));
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
    deferredTools: asList(meta.deferredTools),
    useDefaultPrompt: asBool(meta.useDefaultPrompt),
    model: asString(meta.model),
    subagentType: asString(meta.subagent_type),
  };
}


let seeded = false;
async function ensureSeed(): Promise<void> {
  if (seeded) return;
  seeded = true;
  await fs.mkdir(DIR, { recursive: true });
  // Apply every seed agent (including default_agent) additively — never
  // overwrites an existing file so user edits are always preserved.
  const seedIds = await listSeedIds();
  for (const id of seedIds) await applySeedAgent(id);
  // Phase B strict-allowlist migration: with `empty allowlist = zero tools`,
  // any legacy agent that relied on "unset ⇒ all" would silently lose every
  // tool on upgrade. Backfill each such agent's allowlist with the FULL set
  // of capability ids the ONE TIME they're first read on the new code. The
  // per-agent marker file makes this idempotent — a user who later saves an
  // explicit empty allowlist will keep it (the marker prevents re-migration).
  await backfillLegacyAllowlists();
}

// One-time backfill executed at first read after upgrade. Uses a per-agent
// marker file (.capabilities-migrated) instead of a frontmatter field so the
// Agent schema stays clean.
const MIGRATION_MARKER = ".capabilities-migrated";
const ALL_CAPABILITY_IDS: string[] = CAPABILITIES.map((c) => c.id);

async function backfillLegacyAllowlists(): Promise<void> {
  const entries = await fs.readdir(DIR, { withFileTypes: true }).catch(() => [] as import("fs").Dirent[]);
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    if (d.name === DEFAULT_PROMPT_AGENT_ID) continue;
    const agentDir = path.join(DIR, d.name);
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
  const dirs = await fs.readdir(DIR, { withFileTypes: true }).catch(() => []);
  const agents: Agent[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    if (d.name === DEFAULT_PROMPT_AGENT_ID) continue;
    try {
      const src = await fs.readFile(path.join(DIR, d.name, "AGENT.md"), "utf8");
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
    const src = await fs.readFile(path.join(DIR, DEFAULT_PROMPT_AGENT_ID, "AGENT.md"), "utf8");
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
  await fs.mkdir(path.join(DIR, DEFAULT_PROMPT_AGENT_ID), { recursive: true });
  await writeFileAtomic(path.join(DIR, DEFAULT_PROMPT_AGENT_ID, "AGENT.md"), toMarkdown(updated));
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
  await fs.mkdir(path.join(DIR, id), { recursive: true });
  await writeFileAtomic(path.join(DIR, id, "AGENT.md"), toMarkdown(agent));
  // Mark migrated so ensureSeed doesn't try to re-backfill this agent.
  await writeFileAtomic(path.join(DIR, id, MIGRATION_MARKER), "1");
  return agent;
}

export async function removeSubAgent(idOrName: string): Promise<void> {
  const agent = await getAgent(idOrName);
  if (agent) await fs.rm(path.join(DIR, agent.id), { recursive: true, force: true });
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
  await writeFileAtomic(path.join(DIR, agent.id, "AGENT.md"), toMarkdown(updated));
  return updated;
}

/** Update an agent's capability allowlists (tools/skills/mcp/deferredTools).
 *  Only provided classes are changed. Tools use the strict allowlist migrated
 *  above; skills/MCP keep their unset/empty-means-all behavior; deferredTools
 *  are additive over registry defaults. */
export async function setAgentCapabilities(
  id: string,
  caps: { tools?: string[]; skills?: string[]; mcp?: string[]; deferredTools?: string[] },
): Promise<Agent | undefined> {
  const agent = await getAgent(id);
  if (!agent) return undefined;
  const updated: Agent = {
    ...agent,
    tools: caps.tools ?? agent.tools,
    skills: caps.skills ?? agent.skills,
    mcp: caps.mcp ?? agent.mcp,
    deferredTools: caps.deferredTools ?? agent.deferredTools,
  };
  await writeFileAtomic(path.join(DIR, agent.id, "AGENT.md"), toMarkdown(updated));
  return updated;
}

/** Toggle whether the shared default prompt (default_agent template) is
 *  prepended to this agent's personality. */
export async function setAgentUseDefaultPrompt(id: string, value: boolean): Promise<Agent | undefined> {
  const agent = await getAgent(id);
  if (!agent) return undefined;
  const updated: Agent = { ...agent, useDefaultPrompt: value };
  await writeFileAtomic(path.join(DIR, agent.id, "AGENT.md"), toMarkdown(updated));
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
  await writeFileAtomic(path.join(DIR, agent.id, "AGENT.md"), toMarkdown(updated));
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
  await fs.rm(path.join(DIR, agent.id), { recursive: true, force: true });
}
