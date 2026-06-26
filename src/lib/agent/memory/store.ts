import "server-only";
import { promises as fs } from "fs";
import path from "path";
import type { Memory, MemoryType, RecalledMemory } from "./types";

const FILE = path.join(process.cwd(), "data", "memory", "memories.json");

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "is", "are", "be",
  "with", "that", "this", "it", "as", "at", "by", "from", "into", "about",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

async function readAll(): Promise<Memory[]> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8")) as Memory[];
  } catch {
    return [];
  }
}

async function writeAll(memories: Memory[]): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(memories, null, 2), "utf8");
}

export async function listMemories(): Promise<Memory[]> {
  return (await readAll()).sort((a, b) => b.createdAt - a.createdAt);
}

export async function addMemory(input: {
  type: MemoryType;
  content: string;
  tags?: string[];
}): Promise<Memory> {
  const memories = await readAll();
  const tags = input.tags && input.tags.length ? input.tags : tokenize(input.content).slice(0, 6);

  // De-duplicate near-identical content to keep memory from bloating.
  const existing = memories.find((m) => m.content.trim() === input.content.trim());
  if (existing) {
    existing.usefulness += 1;
    existing.tags = Array.from(new Set([...existing.tags, ...tags]));
    await writeAll(memories);
    return existing;
  }

  const memory: Memory = {
    id: `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type: input.type,
    content: input.content,
    tags,
    createdAt: Date.now(),
    usefulness: 0,
  };
  await writeAll([memory, ...memories]);
  return memory;
}

export async function removeMemory(id: string): Promise<Memory[]> {
  const next = (await readAll()).filter((m) => m.id !== id);
  await writeAll(next);
  return next;
}

/** Retrieve the most relevant memories for a query (keyword + recency + usefulness). */
export async function recall(query: string, limit = 5): Promise<RecalledMemory[]> {
  const memories = await readAll();
  if (memories.length === 0) return [];
  const terms = new Set(tokenize(query));
  const now = Date.now();
  const day = 86_400_000;

  const scored: RecalledMemory[] = memories.map((m) => {
    const content = new Set(tokenize(m.content));
    const tags = new Set(m.tags.map((t) => t.toLowerCase()));
    let score = 0;
    for (const term of terms) {
      if (tags.has(term)) score += 3;
      if (content.has(term)) score += 2;
    }
    const ageDays = (now - m.createdAt) / day;
    score += Math.max(0, 2 - ageDays / 14); // recency boost, decays over ~weeks
    score += Math.min(3, m.usefulness * 0.5); // reinforce useful memories
    return { ...m, score };
  });

  const ranked = scored
    .filter((m) => (terms.size === 0 ? true : m.score > 0.5))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Reinforce recalled memories so useful ones surface more readily next time.
  if (ranked.length) {
    const ids = new Set(ranked.map((m) => m.id));
    for (const m of memories) if (ids.has(m.id)) m.usefulness += 1;
    await writeAll(memories);
  }
  return ranked;
}
