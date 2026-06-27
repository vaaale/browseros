import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import { parseFrontmatter, buildFrontmatter, asString } from "@/lib/agent/subagents/markdown";

const DIR = path.join(dataDir(), "docs");

export interface Doc {
  id: string;
  title: string;
  content: string;
  updatedAt: number;
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `doc-${Date.now().toString(36)}`;
}

const SEED: { title: string; content: string }[] = [
  {
    title: "Getting Started",
    content:
      "# Welcome to BrowserOS\n\nBrowserOS (BOS) is an agentic operating system in your browser.\n\n## Apps\n- **Files** — browse the virtual file system.\n- **Browser** — open web pages.\n- **Assistant** — chat with the BOS agent; it can open apps, manage files, change settings, and build new apps.\n- **Memory** — what the assistant has learned.\n- **Docs** — this documentation hub.\n- **Settings** — configure appearance, the AI provider, the assistant, skills, the dev harness, and manage installed apps.\n\n## The assistant\nThe assistant delegates work to sub-agents. Development tasks use a Claude sub-agent; other tasks use a local sub-agent. Ask it to build an app and it appears on your desktop.\n\n## Managing apps\nApps the assistant builds appear on your desktop. In **Settings → Apps** you can uninstall an app (it is hidden but its files are kept so you can restore it) or purge it (delete its files permanently).",
  },
  {
    title: "Configuring AI Providers",
    content:
      "# AI Providers\n\nOpen **Settings → AI Provider** to choose your provider (Anthropic, OpenAI, OpenAI Codex, or a local OpenAI-compatible server), model, base URL, API key, and token limits.\n\nUse **Test connection** to verify it works.",
  },
];

let seeded = false;
async function ensureSeed(): Promise<void> {
  if (seeded) return;
  seeded = true;
  await fs.mkdir(DIR, { recursive: true });
  const existing = (await fs.readdir(DIR).catch(() => [])).filter((f) => f.endsWith(".md"));
  if (existing.length > 0) return;
  for (const d of SEED) await write({ id: slugify(d.title), title: d.title, content: d.content, updatedAt: Date.now() });
}

async function write(doc: Doc): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  await writeFileAtomic(path.join(DIR, `${doc.id}.md`), buildFrontmatter({ title: doc.title }, doc.content));
}

export async function listDocs(): Promise<Doc[]> {
  await ensureSeed();
  const files = (await fs.readdir(DIR).catch(() => [])).filter((f) => f.endsWith(".md"));
  const docs: Doc[] = [];
  for (const f of files) {
    try {
      const id = f.replace(/\.md$/, "");
      const src = await fs.readFile(path.join(DIR, f), "utf8");
      const { meta, body } = parseFrontmatter(src);
      const stat = await fs.stat(path.join(DIR, f));
      docs.push({ id, title: asString(meta.title) || id, content: body, updatedAt: stat.mtimeMs });
    } catch {
      /* skip */
    }
  }
  return docs.sort((a, b) => a.title.localeCompare(b.title));
}

export async function getDoc(idOrTitle: string): Promise<Doc | undefined> {
  const key = idOrTitle.toLowerCase();
  return (await listDocs()).find((d) => d.id.toLowerCase() === key || d.title.toLowerCase() === key);
}

export async function saveDoc(input: { title: string; content: string }): Promise<Doc> {
  await ensureSeed();
  const doc: Doc = { id: slugify(input.title), title: input.title, content: input.content, updatedAt: Date.now() };
  await write(doc);
  return doc;
}

export async function removeDoc(idOrTitle: string): Promise<void> {
  const doc = await getDoc(idOrTitle);
  if (doc) await fs.rm(path.join(DIR, `${doc.id}.md`), { force: true });
}
