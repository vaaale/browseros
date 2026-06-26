"use client";

import { useCopilotAction } from "@copilotkit/react-core";
import type { Doc } from "@/lib/docs/store";

// Lets the assistant read and update the documentation hub. Per BOS policy, the
// assistant updates docs whenever an app or feature is added/changed/removed.
export function DocsActions() {
  useCopilotAction({
    name: "listDocs",
    description: "List documentation pages in the BOS documentation hub.",
    parameters: [],
    handler: async () => {
      const res = await fetch("/api/docs").then((r) => r.json());
      return JSON.stringify((res.docs ?? []).map((d: Doc) => ({ id: d.id, title: d.title })));
    },
  });

  useCopilotAction({
    name: "readDoc",
    description: "Read a documentation page by id or title.",
    parameters: [{ name: "id", type: "string", description: "Doc id or title", required: true }],
    handler: async ({ id }) => {
      const res = await fetch(`/api/docs?id=${encodeURIComponent(id as string)}`).then((r) => r.json());
      const d: Doc | undefined = res.doc;
      return d ? `# ${d.title}\n${d.content}` : `No doc "${id}".`;
    },
  });

  useCopilotAction({
    name: "writeDoc",
    description:
      "Create or update a documentation page (markdown). Call this whenever you add, modify, or remove an app or feature.",
    parameters: [
      { name: "title", type: "string", description: "Doc title", required: true },
      { name: "content", type: "string", description: "Markdown content", required: true },
    ],
    handler: async ({ title, content }) => {
      const res = await fetch("/api/docs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content }),
      }).then((r) => r.json());
      return res.error ? `Error: ${res.error}` : `Saved doc "${res.doc.title}".`;
    },
  });

  return null;
}
