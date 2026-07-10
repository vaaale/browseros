import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { docsTree, getDoc, isSection, type DocNode } from "@/lib/docs/store";

// Read-only browsing of the project documentation tree (docs/usage/** +
// docs/dev/**), ported from DocsActions.tsx.

export function docsTools(): Record<string, AssistantTool> {
  return {
    docs_list: serverTool(
      "docs_list",
      "List documentation pages in the BOS documentation tree (usage = end-user docs, dev = developer docs). Returns refs like 'usage/apps/files.md'.",
      schema(),
      async () => {
        const tree = await docsTree();
        const flat: { ref: string; title: string }[] = [];
        const walk = (section: string, nodes: DocNode[] = []) => {
          for (const n of nodes) {
            if (n.type === "file") flat.push({ ref: `${section}/${n.path}`, title: n.title });
            else walk(section, n.children);
          }
        };
        for (const section of Object.keys(tree)) walk(section, tree[section as keyof typeof tree]);
        return JSON.stringify(flat);
      },
    ),

    docs_read: serverTool(
      "docs_read",
      "Read a documentation page by ref, e.g. 'usage/apps/files.md' or 'dev/memory/memory.md' (the first path segment is the section: usage or dev).",
      schema({ ref: p.str("Doc ref like 'usage/apps/files.md'") }, ["ref"]),
      async (input) => {
        const ref = String(input.ref ?? "");
        const raw = ref.replace(/^\/+/, "");
        const slash = raw.indexOf("/");
        if (slash < 0) return `Invalid ref "${ref}". Use 'usage/...' or 'dev/...'.`;
        const section = raw.slice(0, slash);
        const docPath = raw.slice(slash + 1);
        if (!isSection(section)) return `Invalid ref "${ref}". Use 'usage/...' or 'dev/...'.`;
        const doc = await getDoc(section, docPath);
        return doc ? doc.content : `No doc "${ref}".`;
      },
    ),
  };
}
