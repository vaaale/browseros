"use client";

import { useCopilotAction } from "@/components/agent/gated-action";

// Client-side specification actions (016-unified-agents FR-006), over /api/specs
// (jailed to specs/ + .specify/). They let an active-personality agent — Build
// Studio — author specs directly instead of being forced to delegate. Mirrors the
// server-side SPEC_TOOLS (read_spec/write_spec/…) used when an agent is delegated to.
// Gated by the agent's allowlist via the shim import above.

interface TreeNode {
  type: string;
  path: string;
  name: string;
  children?: TreeNode[];
}

function flattenFiles(nodes: TreeNode[] = []): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.children && n.children.length) out.push(...flattenFiles(n.children));
    else out.push(n.path);
  }
  return out;
}

export function SpecActions() {
  useCopilotAction({
    name: "listSpecs",
    description: "List specification artifacts across the spec stores (e.g. 'bos-system-specs', 'user-specs'): feature folders and their files. Paths returned are store-prefixed (`<storeId>/<feature>/<file>`).",
    parameters: [],
    handler: async () => {
      const res = await fetch("/api/specs").then((r) => r.json());
      const files = flattenFiles(res.tree);
      const specs = (res.specs ?? []).map((s: { id: string; title?: string }) => ({ id: s.id, title: s.title }));
      return JSON.stringify({ specs, files });
    },
  });

  useCopilotAction({
    name: "readSpec",
    description: "Read a specification artifact by its STORE-PREFIXED path, e.g. 'bos-system-specs/016-unified-agents/spec.md' or 'bos-system-specs/.specify/memory/constitution.md'.",
    parameters: [{ name: "path", type: "string", description: "Store-prefixed artifact path, e.g. 'user-specs/003-x/spec.md'", required: true }],
    handler: async ({ path }) => {
      const res = await fetch(`/api/specs?path=${encodeURIComponent(String(path ?? ""))}`).then((r) => r.json());
      return res.error ? `Error: ${res.error}` : String(res.content ?? "");
    },
  });

  useCopilotAction({
    name: "writeSpec",
    description: "Create or overwrite a specification artifact by STORE-PREFIXED path. New specs go in the user store; system-store edits require Promote. Provide the FULL file content.",
    parameters: [
      { name: "path", type: "string", description: "Store-prefixed artifact path, e.g. 'user-specs/003-x/spec.md'", required: true },
      { name: "content", type: "string", description: "Full file content", required: true },
    ],
    handler: async ({ path, content }) => {
      const res = await fetch("/api/specs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content }),
      }).then((r) => r.json());
      return res.error ? `Error: ${res.error}` : `Wrote ${res.path}`;
    },
  });

  useCopilotAction({
    name: "editSpec",
    description: "Find-and-replace within a specification artifact. The find text must appear EXACTLY once.",
    parameters: [
      { name: "path", type: "string", description: "Artifact path", required: true },
      { name: "find", type: "string", description: "Exact text to replace", required: true },
      { name: "replace", type: "string", description: "Replacement text", required: true },
    ],
    handler: async ({ path, find, replace }) => {
      const p = String(path ?? "");
      const cur = await fetch(`/api/specs?path=${encodeURIComponent(p)}`).then((r) => r.json());
      if (cur.error) return `Error: ${cur.error}`;
      const content = String(cur.content ?? "");
      const f = String(find ?? "");
      const occurrences = f ? content.split(f).length - 1 : 0;
      if (occurrences === 0) return `Error: "find" text not found in ${p}.`;
      if (occurrences > 1) return `Error: "find" text appears ${occurrences} times in ${p}; make it unique.`;
      const next = content.replace(f, String(replace ?? ""));
      const res = await fetch("/api/specs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: p, content: next }),
      }).then((r) => r.json());
      return res.error ? `Error: ${res.error}` : `Edited ${res.path}`;
    },
  });

  useCopilotAction({
    name: "searchSpecs",
    description: "Search specification artifacts by path/name (case-insensitive substring). Returns matching artifact paths.",
    parameters: [{ name: "query", type: "string", description: "Search text", required: true }],
    handler: async ({ query }) => {
      const q = String(query ?? "").toLowerCase();
      const res = await fetch("/api/specs").then((r) => r.json());
      return JSON.stringify(flattenFiles(res.tree).filter((p) => p.toLowerCase().includes(q)));
    },
  });

  return null;
}
