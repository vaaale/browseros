"use client";

import { useCopilotAction } from "@copilotkit/react-core";

// Read-only browsing of the project documentation tree: docs/usage/** (end
// users) and docs/dev/** (developers). The docs are SOURCE files — to change
// them, edit the tree via the developer sub-agent; there is no runtime write
// action.
interface DocNode {
  type: "file" | "dir";
  path: string;
  title: string;
  children?: DocNode[];
}

export function DocsActions() {
  useCopilotAction({
    name: "docs_list",
    description:
      "List documentation pages in the BOS documentation tree (usage = end-user docs, dev = developer docs). Returns refs like 'usage/apps/files.md'.",
    parameters: [],
    handler: async () => {
      const res = (await fetch("/api/docs").then((r) => r.json())) as { tree?: Record<string, DocNode[]> };
      const flat: { ref: string; title: string }[] = [];
      const walk = (section: string, nodes: DocNode[] = []) => {
        for (const n of nodes) {
          if (n.type === "file") flat.push({ ref: `${section}/${n.path}`, title: n.title });
          else walk(section, n.children);
        }
      };
      for (const section of Object.keys(res.tree ?? {})) walk(section, res.tree?.[section]);
      return JSON.stringify(flat);
    },
  });

  useCopilotAction({
    name: "docs_read",
    description:
      "Read a documentation page by ref, e.g. 'usage/apps/files.md' or 'dev/memory/memory.md' (the first path segment is the section: usage or dev).",
    parameters: [{ name: "ref", type: "string", description: "Doc ref like 'usage/apps/files.md'", required: true }],
    handler: async ({ ref }) => {
      const raw = String(ref ?? "").replace(/^\/+/, "");
      const slash = raw.indexOf("/");
      if (slash < 0) return `Invalid ref "${ref}". Use 'usage/...' or 'dev/...'.`;
      const section = raw.slice(0, slash);
      const docPath = raw.slice(slash + 1);
      const res = (await fetch(
        `/api/docs?section=${encodeURIComponent(section)}&path=${encodeURIComponent(docPath)}`,
      ).then((r) => r.json())) as { doc?: { content: string }; error?: string };
      return res.doc ? res.doc.content : res.error ? `Error: ${res.error}` : `No doc "${ref}".`;
    },
  });

  return null;
}
