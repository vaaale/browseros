import "server-only";
import { promises as fs } from "fs";
import * as vfs from "@/os/vfs";
import { hostPath } from "@/os/vfs";
import { logger } from "@/lib/logging";
import { looksLikeInjection } from "./injection";

// Episodic memory (specs/bos-system-specs/021-memory-loops §Episodic store).
// One markdown file per conversation per day, under
// /Documents/Memory/Episodes/<yyyy-mm-dd>-<conversationId>.md. The fast loop is
// the ONLY writer at runtime; the slow loop reads pending episodes, marks them
// consolidated, and archives entries older than the archive age.
//
// Files are markdown with YAML-ish frontmatter delimited by "---" — the same
// pattern used by SKILL.md. Writes go through VFS.writeText (atomic temp+rename
// via writeFileAtomic), so a crash mid-write never leaves a torn file.

const LOG = "memory.episodes";
export const EPISODES_DIR = "/Documents/Memory/Episodes";
export const EPISODES_ARCHIVE_DIR = "/Documents/Memory/Episodes/.Archive";

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
  /** Last reviewed message id (or index-as-string) — advances with each review. */
  watermark: string;
  /** Ids of skills observed during the reviewed slice. Populated mechanically. */
  skillsUsed: string[];
  status: EpisodeStatus;
  /** Task-class slugs to feed the slow-loop recurrence gate. */
  skillCandidates?: string[];
}

export interface Episode {
  meta: EpisodeMeta;
  /** Section body keyed by section header (in canonical order). Missing == "". */
  sections: Partial<Record<EpisodeSection, string>>;
  /** VFS path this episode lives at. */
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

export function episodePath(conversationId: string, day: string = dayStamp()): string {
  return `${EPISODES_DIR}/${day}-${safeConvId(conversationId)}.md`;
}

// ── Frontmatter (de)serialization ─────────────────────────────────────────
// Kept intentionally minimal — YAML-ish, one key per line, string arrays as
// JSON literals. This avoids pulling in yaml as a dependency and matches how
// the skills store does it.

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

/** Serialize writes per (conversationId, day) file so read-modify-write
 *  reviews don't clobber concurrent updates. Node is single-threaded but
 *  awaits interleave. */
const fileLocks = new Map<string, Promise<unknown>>();
function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  fileLocks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

// ── Public API ────────────────────────────────────────────────────────────

/** Create a fresh episode file for a conversation on today's date. Idempotent:
 *  if a file already exists for (convId, today), returns the parsed existing
 *  episode without overwriting anything. */
export async function createEpisode(conversationId: string): Promise<Episode> {
  safeConvId(conversationId);
  const path = episodePath(conversationId);
  return withFileLock(path, async () => {
    if (await exists(path)) return parseFile(path, conversationId);
    const now = new Date().toISOString();
    const episode: Episode = {
      meta: {
        conversationId,
        createdAt: now,
        updatedAt: now,
        watermark: "",
        status: "pending",
        skillsUsed: [],
      },
      sections: {},
      path,
    };
    await ensureDir(EPISODES_DIR);
    await vfs.writeText(path, serializeEpisode(episode));
    return episode;
  });
}

/** Merge an update into today's episode for a conversation. Sections are
 *  replaced when supplied and non-empty; other metadata is merged. Injection
 *  scans reject suspicious content in every supplied section body.
 *  Idempotent per (convId, day). */
export async function updateEpisode(
  conversationId: string,
  updates: EpisodeUpdate,
): Promise<Episode> {
  safeConvId(conversationId);
  const path = episodePath(conversationId);
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
          logger().warn(LOG, "dropped section — injection pattern", {
            conversationId,
            section: header,
          });
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
      nextMeta.skillCandidates = dedupeStrings([
        ...(current.meta.skillCandidates ?? []),
        ...updates.skillCandidates,
      ]);
    }

    const next: Episode = { meta: nextMeta, sections, path };
    await ensureDir(EPISODES_DIR);
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

/** Read today's episode for a conversation (returns null if none). */
export async function getEpisode(conversationId: string): Promise<Episode | null> {
  return readEpisodeAt(episodePath(conversationId), conversationId);
}

/** List every episode file under Episodes/ (excluding .Archive/), oldest-first
 *  by embedded `createdAt`. */
export async function listEpisodes(opts: { includeConsolidated?: boolean } = {}): Promise<Episode[]> {
  await ensureDir(EPISODES_DIR);
  const entries = await vfs.list(EPISODES_DIR).catch(() => []);
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

/** List pending episodes oldest-first. */
export async function listPendingEpisodes(limit?: number): Promise<Episode[]> {
  const all = await listEpisodes();
  const pending = all.filter((e) => e.meta.status === "pending");
  return limit ? pending.slice(0, Math.max(0, limit)) : pending;
}

/** Mark today's episode as consolidated. No-op if the episode does not exist. */
export async function markEpisodeConsolidated(conversationId: string): Promise<Episode | null> {
  const path = episodePath(conversationId);
  return withFileLock(path, async () => {
    const ep = await readEpisodeAt(path, conversationId);
    if (!ep) return null;
    const next: Episode = {
      ...ep,
      meta: { ...ep.meta, status: "consolidated", updatedAt: new Date().toISOString() },
    };
    await vfs.writeText(path, serializeEpisode(next));
    return next;
  });
}

/** Mark any episode file (by VFS path) as consolidated — used by the slow loop
 *  when it processes historical files, not just today's. */
export async function markEpisodePathConsolidated(vfsPath: string): Promise<Episode | null> {
  return withFileLock(vfsPath, async () => {
    const ep = await readEpisodeAt(vfsPath, "");
    if (!ep) return null;
    const next: Episode = {
      ...ep,
      meta: { ...ep.meta, status: "consolidated", updatedAt: new Date().toISOString() },
    };
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

/** Count how many episode files carry a matching skill-candidate tag.
 *  Cheap linear scan — episodes are text markdown, dozens per week at most. */
export async function countSkillCandidateOccurrences(taskClass: string): Promise<number> {
  const slug = taskClass.trim();
  if (!slug) return 0;
  const all = await listEpisodes({ includeConsolidated: true });
  let n = 0;
  for (const ep of all) {
    if ((ep.meta.skillCandidates ?? []).includes(slug)) n += 1;
  }
  return n;
}

/** Move consolidated episodes older than `olderThanDays` into .Archive/. Never
 *  deletes files — a mistaken consolidation can always be recovered by hand. */
export async function archiveOldEpisodes(olderThanDays: number = 14): Promise<number> {
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) return 0;
  await ensureDir(EPISODES_ARCHIVE_DIR);
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  const entries = await vfs.list(EPISODES_DIR).catch(() => []);
  const files = entries.filter((e) => e.type === "file" && e.name.endsWith(".md"));
  let moved = 0;
  for (const e of files) {
    const ep = await readEpisodeAt(e.path, e.name.replace(/\.md$/, ""));
    if (!ep || ep.meta.status !== "consolidated") continue;
    const created = Date.parse(ep.meta.createdAt);
    if (!Number.isFinite(created) || created > cutoff) continue;
    const target = `${EPISODES_ARCHIVE_DIR}/${e.name}`;
    try {
      await vfs.rename(e.path, target);
      moved += 1;
    } catch (err) {
      logger().warn(LOG, "archive rename failed", { path: e.path, err: (err as Error).message });
    }
  }
  if (moved > 0) logger().info(LOG, `archived ${moved} episode(s)`, { olderThanDays });
  return moved;
}
