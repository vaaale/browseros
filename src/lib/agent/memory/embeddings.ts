import "server-only";
import * as vfs from "@/os/vfs";
import { agentEmbeddingsFile } from "./paths";
import { getProviderConfig, resolveEmbeddingConfig } from "@/lib/agent/provider";
import { embed } from "@/lib/agent/llm";

// Per-agent embedding cache (028-memory-curation-retrieval, T3, ADR-3). Dense
// vectors are expensive to compute and cheap to cache — this wraps the
// provider-agnostic `embed()` call with a sidecar JSON file keyed by the
// entry's content-hash id (topics.ts's hashId). Because the id IS a hash of
// the entry's clean text, recompute-on-text-change (FR-013) falls out by
// construction: unchanged text -> same id -> cache hit; changed text -> new
// id -> miss -> recompute. Never inlined into a topic .md (would pollute the
// human-readable file and count toward its budget).

interface CachedEmbedding {
  model: string;
  dim: number;
  vector: number[];
}

interface EmbeddingCacheFile {
  model: string;
  entries: Record<string, CachedEmbedding>;
}

function emptyCache(): EmbeddingCacheFile {
  return { model: "", entries: {} };
}

async function readCache(agentId: string): Promise<EmbeddingCacheFile> {
  try {
    const raw = await vfs.readText(agentEmbeddingsFile(agentId));
    const parsed = JSON.parse(raw) as Partial<EmbeddingCacheFile>;
    return { model: parsed.model ?? "", entries: parsed.entries ?? {} };
  } catch {
    return emptyCache();
  }
}

async function writeCache(agentId: string, cache: EmbeddingCacheFile): Promise<void> {
  await vfs.writeText(agentEmbeddingsFile(agentId), JSON.stringify(cache));
}

// Per-agent write serialization so a burst of cold-cache embeds during one
// search (bounded to top-K, see search.ts) doesn't clobber concurrent writes.
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(agentId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(agentId, run.then(() => undefined, () => undefined));
  return run;
}

/** Resolve (from cache, or by computing) the embedding for one topic entry.
 *  Returns `null` — never throws — when embeddings are disabled or the
 *  provider can't serve them; callers (search.ts) drop the dense term for
 *  this candidate and renormalize (FR-016). A cached vector computed under a
 *  since-changed embedding MODEL is treated as a miss and recomputed. */
export async function getEmbedding(agentId: string, entry: { id: string; text: string }): Promise<number[] | null> {
  const c = await getProviderConfig();
  const resolved = resolveEmbeddingConfig(c);
  const model = resolved.model;
  if (!resolved.enabled || !model) return null;

  const cache = await readCache(agentId);
  const cached = cache.entries[entry.id];
  if (cached && cached.model === model) return cached.vector;

  const vector = await embed(resolved, entry.text);
  if (!vector) return null;

  await withLock(agentId, async () => {
    const fresh = await readCache(agentId);
    fresh.model = model;
    fresh.entries[entry.id] = { model, dim: vector.length, vector };
    await writeCache(agentId, fresh);
  });
  return vector;
}

/** Embed a search query. Same degradation contract as getEmbedding, but never
 *  cached (queries are one-shot; only entry text is durable content worth
 *  persisting a vector for). */
export async function embedQuery(text: string): Promise<number[] | null> {
  const c = await getProviderConfig();
  const resolved = resolveEmbeddingConfig(c);
  if (!resolved.enabled || !resolved.model) return null;
  return embed(resolved, text);
}

/** Drop cached vectors for ids no longer present in any current topic entry
 *  (bounds the cache file; ADR-3). Best-effort — called lazily by a slow-loop
 *  pass or after a search, never inline on the write path. */
export async function pruneEmbeddingCache(agentId: string, validIds: ReadonlySet<string>): Promise<void> {
  await withLock(agentId, async () => {
    const cache = await readCache(agentId);
    let changed = false;
    for (const id of Object.keys(cache.entries)) {
      if (!validIds.has(id)) {
        delete cache.entries[id];
        changed = true;
      }
    }
    if (changed) await writeCache(agentId, cache);
  });
}
