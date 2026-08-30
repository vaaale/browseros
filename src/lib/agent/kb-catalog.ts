import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { getInstalledItem } from "@/system/items/installed";

// Read-only view of the Knowledge Base marketplace item's own KB list
// (038-knowledge-base). The item owns `data/kbs.json` under its own item root
// (`KnowledgeBase` key entity: id, name, description, ...); this module never
// writes it — the item's app facet is the only editor. This mirrors how
// `skills/store.ts` / `mcp/store.ts` are the catalogs consumed by
// `instructions.ts` and the Settings → Agents capability pickers.

const ITEM_ID = "knowledge-base";

export interface KnowledgeBaseCatalogEntry {
  id: string;
  name: string;
  description?: string;
}

function isCatalogEntry(v: unknown): v is KnowledgeBaseCatalogEntry {
  return !!v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" && typeof (v as { name?: unknown }).name === "string";
}

/** Every knowledge base the item currently knows about, or `[]` if the item
 *  isn't installed or its data file is missing/malformed — never throws, so a
 *  KB-less BOS renders an empty picker rather than a broken Settings page. */
export async function listKnowledgeBases(): Promise<KnowledgeBaseCatalogEntry[]> {
  const item = await getInstalledItem(ITEM_ID);
  if (!item || item.broken) return [];
  try {
    const raw = await fs.readFile(path.join(item.itemPath, "data", "kbs.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { kbs?: unknown })?.kbs) ? (parsed as { kbs: unknown[] }).kbs : [];
    return list.filter(isCatalogEntry);
  } catch {
    return [];
  }
}
