import "server-only";
import { promises as fs } from "fs";
import * as vfs from "@/os/vfs";
import { hostPath } from "@/os/vfs";
import { logger } from "@/lib/logging";
import { looksLikeInjection } from "./injection";
import { agentEpisodesDir, agentEpisodesArchiveDir } from "./paths";

// Per-agent episodic memory (023-per-agent-memory, spec 021 §Episodic store).
// One markdown file per conversation per day, under
// /Memories/<agentId>/Episodes/<yyyy-mm-dd>-<conversationId>.md. The fast loop
// is the ONLY writer at runtime; the slow loop reads pending episodes, marks
// them consolidated, and archives entries older than the archive age.

const LOG = "memory.episodes";

const SECTION_HEADERS = [
  "Task & outcome",
  "What worked / what failed",
  "Corrections received",
  "Durable lesson candidates",
  "Profile suggestions",
] as const;

export type EpisodeSection = (typeof SECTION_HEADERS)[number];
export type EpisodeStatus = "pending" | "consolidated";

export interface EpisodeMeta {
  conversationId: string;
  createdAt: string;
  updatedAt: string;
  watermark: string;
  skillsUsed: string[];
  status: EpisodeStatus;
  skillCandidates?: string[];
}

export interface Episode {
  meta: EpisodeMeta;
  sections: Partial<Record<EpisodeSection, string>>;
  path: string;
}

export interface EpisodeUpdate {
  sections?: Partial<Record<EpisodeSection, string>>;
  watermark?: string;
  skillsUsed?: string[];
  skillCandidates?: string[];
  status?: EpisodeStatus;
}

// ── Path helpers ──────────────────────────────────────────────────────────

function dayStamp(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function safeConvId(id: string): string {
  const t = id.trim();
  if (!t) throw new Error("conversationId is required");
  if (!/^[A-Za-z0-9._-]+$/.test(t)) {
    throw new Error(`Invalid conversationId "${id}" — expected [A-Za-z0-9._-] only`);
  }
  return t;
}

export function episodePath(agentId: string, conversationId: string, day: string = dayStamp()): string {
  return `${agentEpisodesDir(agentId)}/${day}-${safeConvId(conversationId)}.md`;
}

// ── Frontmatter (de)serialization ─────────────────────────────────────────

function serializeMeta(meta: EpisodeMeta): string {
  const lines: string[] = [];
  lines.push(`conversationId: ${meta.conversationId}`);
  lines.push(`createdAt: ${meta.createdAt}`);
  lines.push(`updatedAt: ${meta.updatedAt}`);
  lines.push(`watermark: ${JSON.stringify(meta.watermark ?? "")}`);
  lines.push(`status: ${meta.status}`);
  lines.push(`skillsUsed: ${JSON.stringify(meta.skillsUsed ?? [])}`);
  if (meta.skillCandidates && meta.skillCandidates.length > 0) {
    lines.push(`skillCandidates: ${JSON.stringify(meta.skillCandidates)}`);
  }
  return lines.join("\n");
}

function parseMeta(raw: string, fallbackConvId: string): EpisodeMeta {
  const meta: Partial<EpisodeMeta> = {};
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    switch (key) {
      case "conversationId":
        meta.conversationId = value;
        break;
      case "createdAt":
        meta.createdAt = value;
        break;
      case "updatedAt":
        meta.updatedAt = value;
        break;
      case "watermark":
        try {
          meta.watermark = value.startsWith('"') ? (JSON.parse(value) as string) : value;
        } catch {
          meta.watermark = value;
        }
        break;
      case "status":
        meta.status = (value === "consolidated" ? "consolidated" : "pending") as EpisodeStatus;
        break;
      case "skillsUsed":
        try {
          const arr = JSON.parse(value);
          meta.skillsUsed = Array.isArray(arr) ? arr.map(String) : [];
        } catch {
          meta.skillsUsed = [];
        }
        break;
      case "skillCandidates":
        try {
          const arr = JSON.parse(value);
          if (Array.isArray(arr) && arr.length > 0) meta.skillCandidates = arr.map(String);
        } catch {
          /* skip */
        }
        break;
    }
  }
  const now = new Date().toISOString();
  return {
    conversationId: meta.conversationId ?? fallbackConvId,
    createdAt: meta.createdAt ?? now,
    updatedAt: meta.updatedAt ?? now,
    watermark: meta.watermark ?? "",
    status: meta.status ?? "pending",
    skillsUsed: meta.skillsUsed ?? [],
    ...(meta.skillCandidates ? { skillCandidates: meta.skillCandidates } : {}),
  };
}

function splitSections(body: string): Partial<Record<EpisodeSection, string>> {
  const out: Partial<Record<EpisodeSection, string>> = {};
  const lines = body.split(/\r?\n/);
  let current: EpisodeSection | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current) out[current] = buffer.join("\n").trim();
    buffer = [];
  };
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      const header = m[1].trim() as EpisodeSection;
      if ((SECTION_HEADERS as readonly string[]).includes(header)) {
        flush();
        current = header;
        continue;
      }
    }
    if (current) buffer.push(line);
  }
  flush();
  return out;
}

function renderSections(sections: Partial<Record<EpisodeSection, string>>): string {
  const parts: string[] = [];
  for (const header of SECTION_HEADERS) {
    const value = (sections[header] ?? "").trim();
    parts.push(`## ${header}\n\n${value || "_(none)_"}`);
  }
  return parts.join("\n\n");
}

function serializeEpisode(episode: Episode): string {
  const front = serializeMeta(episode.meta);
  const body = renderSections(episode.sections);
  return `---\n${front}\n---\n\n${body}\n`;
}

function parseEpisode(raw: string, path: string, fallbackConvId: string): Episode {
  const trimmed = raw.replace(/^﻿/, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(trimmed);
  const metaRaw = m ? m[1] : "";
  const body = m ? m[2] : trimmed;
  const meta = parseMeta(metaRaw, fallbackConvId);
  const sections = splitSections(body);
  return { meta, sections, path };
}

// ── VFS helpers ───────────────────────────────────────────────────────────

async function ensureDir(vfsDir: string): Promise<void> {
  await vfs.mkdir(vfsDir);
}

async function exists(vfsPath: string): Promise<boolean> {
  try {
    await fs.stat(hostPath(vfsPath));
    return true;
  } catch {
    return false;
  }
}

const fileLocks = new Map<string, Promise<unknown>>();
function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  fileLocks.set(key, run.then(() => undefined, () => undefined));
  return run;
}

// ── Public API ────────────────────────────────────────────────────────────

/** Create a fresh episode for (agent, conversation, today). Idempotent. */
export async function createEpisode(agentId: string, conversationId: string): Promise<Episode> {
  safeConvId(conversationId);
  const path = episodePath(agentId, conversationId);
  return withFileLock(path, async () => {
    if (await exists(path)) return parseFile(path, conversationId);
    const now = new Date().toISOString();
    const episode: Episode = {
      meta: { conversationId, createdAt: now, updatedAt: now, watermark: "", status: "pending", skillsUsed: [] },
      sections: {},
      path,
    };
    await ensureDir(agentEpisodesDir(agentId));
    await vfs.writeText(path, serializeEpisode(episode));
    return episode;
  });
}

/** Merge an update into today's episode for (agent, conversation). */
export async function updateEpisode(
  agentId: string,
  conversationId: string,
  updates: EpisodeUpdate,
): Promise<Episode> {
  safeConvId(conversationId);
  const path = episodePath(agentId, conversationId);
  return withFileLock(path, async () => {
    const current = (await readEpisodeAt(path, conversationId)) ?? {
      meta: {
        conversationId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        watermark: "",
        status: "pending" as EpisodeStatus,
        skillsUsed: [],
      },
      sections: {},
      path,
    };

    const sections: Partial<Record<EpisodeSection, string>> = { ...current.sections };
    if (updates.sections) {
      for (const [k, v] of Object.entries(updates.sections)) {
        const header = k as EpisodeSection;
        if (!(SECTION_HEADERS as readonly string[]).includes(header)) continue;
        const text = (v ?? "").toString();
        if (!text.trim()) continue;
        if (looksLikeInjection(text)) {
          logger().warn(LOG, "dropped section — injection pattern", { agentId, conversationId, section: header });
          continue;
        }
        sections[header] = text.trim();
      }
    }

    const nextMeta: EpisodeMeta = {
      ...current.meta,
      updatedAt: new Date().toISOString(),
      ...(updates.watermark !== undefined ? { watermark: updates.watermark } : {}),
      ...(updates.status ? { status: updates.status } : {}),
      ...(updates.skillsUsed
        ? { skillsUsed: dedupeStrings([...(current.meta.skillsUsed ?? []), ...updates.skillsUsed]) }
        : {}),
    };
    if (updates.skillCandidates && updates.skillCandidates.length > 0) {
      nextMeta.skillCandidates = dedupeStrings([...(current.meta.skillCandidates ?? []), ...updates.skillCandidates]);
    }

    const next: Episode = { meta: nextMeta, sections, path };
    await ensureDir(agentEpisodesDir(agentId));
    await vfs.writeText(path, serializeEpisode(next));
    return next;
  });
}

function dedupeStrings(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const t = x.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

async function readEpisodeAt(path: string, fallbackConvId: string): Promise<Episode | null> {
  try {
    const raw = await vfs.readText(path);
    return parseEpisode(raw, path, fallbackConvId);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function parseFile(path: string, fallbackConvId: string): Promise<Episode> {
  const ep = await readEpisodeAt(path, fallbackConvId);
  if (!ep) throw new Error(`Missing episode at ${path}`);
  return ep;
}

/** Read today's episode for (agent, conversation) (null if none). */
export async function getEpisode(agentId: string, conversationId: string): Promise<Episode | null> {
  return readEpisodeAt(episodePath(agentId, conversationId), conversationId);
}

/** List every episode file for an agent (excluding .Archive/), oldest-first. */
export async function listEpisodes(agentId: string, opts: { includeConsolidated?: boolean } = {}): Promise<Episode[]> {
  const dir = agentEpisodesDir(agentId);
  await ensureDir(dir);
  const entries = await vfs.list(dir).catch(() => []);
  const files = entries.filter((e) => e.type === "file" && e.name.endsWith(".md"));
  const out: Episode[] = [];
  for (const e of files) {
    const ep = await readEpisodeAt(e.path, e.name.replace(/\.md$/, ""));
    if (!ep) continue;
    if (!opts.includeConsolidated && ep.meta.status === "consolidated") continue;
    out.push(ep);
  }
  out.sort((a, b) => (a.meta.createdAt < b.meta.createdAt ? -1 : 1));
  return out;
}

/** List pending episodes for an agent oldest-first. */
export async function listPendingEpisodes(agentId: string, limit?: number): Promise<Episode[]> {
  const all = await listEpisodes(agentId);
  const pending = all.filter((e) => e.meta.status === "pending");
  return limit ? pending.slice(0, Math.max(0, limit)) : pending;
}

/** Mark any episode file (by VFS path) as consolidated. */
export async function markEpisodePathConsolidated(vfsPath: string): Promise<Episode | null> {
  return withFileLock(vfsPath, async () => {
    const ep = await readEpisodeAt(vfsPath, "");
    if (!ep) return null;
    const next: Episode = { ...ep, meta: { ...ep.meta, status: "consolidated", updatedAt: new Date().toISOString() } };
    await vfs.writeText(vfsPath, serializeEpisode(next));
    return next;
  });
}

/** Append a skill-candidate tag to an episode (recurrence gate signal). */
export async function tagSkillCandidate(vfsPath: string, taskClass: string): Promise<Episode | null> {
  const slug = taskClass.trim();
  if (!slug) return null;
  return withFileLock(vfsPath, async () => {
    const ep = await readEpisodeAt(vfsPath, "");
    if (!ep) return null;
    const next: Episode = {
      ...ep,
      meta: {
        ...ep.meta,
        skillCandidates: dedupeStrings([...(ep.meta.skillCandidates ?? []), slug]),
        updatedAt: new Date().toISOString(),
      },
    };
    await vfs.writeText(vfsPath, serializeEpisode(next));
    return next;
  });
}

/** Count how many of an agent's episodes carry a matching skill-candidate tag. */
export async function countSkillCandidateOccurrences(agentId: string, taskClass: string): Promise<number> {
  const slug = taskClass.trim();
  if (!slug) return 0;
  const all = await listEpisodes(agentId, { includeConsolidated: true });
  let n = 0;
  for (const ep of all) {
    if ((ep.meta.skillCandidates ?? []).includes(slug)) n += 1;
  }
  return n;
}

// ── Filename-based lookup / deletion (spec 023 API) ──────────────────────

const EPISODE_FILENAME_RE = /^[A-Za-z0-9._-]+\.md$/;

function assertEpisodeFilename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("filename is required");
  if (!EPISODE_FILENAME_RE.test(trimmed) || trimmed.includes("..")) {
    throw new Error(`Invalid episode filename: ${name}`);
  }
  return trimmed;
}

export async function getEpisodeByFilename(agentId: string, filename: string): Promise<Episode | null> {
  const safe = assertEpisodeFilename(filename);
  const path = `${agentEpisodesDir(agentId)}/${safe}`;
  return readEpisodeAt(path, safe.replace(/\.md$/, ""));
}

export async function deleteEpisodeByFilename(agentId: string, filename: string): Promise<boolean> {
  const safe = assertEpisodeFilename(filename);
  const path = `${agentEpisodesDir(agentId)}/${safe}`;
  return withFileLock(path, async () => {
    if (!(await exists(path))) return false;
    await vfs.remove(path);
    logger().info(LOG, "episode deleted", { agentId, filename: safe });
    return true;
  });
}

export async function archiveEpisodeByFilename(agentId: string, filename: string): Promise<boolean> {
  const safe = assertEpisodeFilename(filename);
  const src = `${agentEpisodesDir(agentId)}/${safe}`;
  const dst = `${agentEpisodesArchiveDir(agentId)}/${safe}`;
  return withFileLock(src, async () => {
    if (!(await exists(src))) return false;
    await ensureDir(agentEpisodesArchiveDir(agentId));
    await vfs.rename(src, dst);
    logger().info(LOG, "episode archived", { agentId, filename: safe });
    return true;
  });
}

/** Move an agent's consolidated episodes older than `olderThanDays` into .Archive/. */
export async function archiveOldEpisodes(agentId: string, olderThanDays: number = 14): Promise<number> {
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) return 0;
  await ensureDir(agentEpisodesArchiveDir(agentId));
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  const entries = await vfs.list(agentEpisodesDir(agentId)).catch(() => []);
  const files = entries.filter((e) => e.type === "file" && e.name.endsWith(".md"));
  let moved = 0;
  for (const e of files) {
    const ep = await readEpisodeAt(e.path, e.name.replace(/\.md$/, ""));
    if (!ep || ep.meta.status !== "consolidated") continue;
    const created = Date.parse(ep.meta.createdAt);
    if (!Number.isFinite(created) || created > cutoff) continue;
    const target = `${agentEpisodesArchiveDir(agentId)}/${e.name}`;
    try {
      await vfs.rename(e.path, target);
      moved += 1;
    } catch (err) {
      logger().warn(LOG, "archive rename failed", { agentId, path: e.path, err: (err as Error).message });
    }
  }
  if (moved > 0) logger().info(LOG, `archived ${moved} episode(s)`, { agentId, olderThanDays });
  return moved;
}
