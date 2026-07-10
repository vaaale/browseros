"use client";

import { useEffect, useRef } from "react";
import { useCopilotAction } from "@copilotkit/react-core";
import { useActiveConversation } from "@/lib/agent/conversations";
import { DEFAULT_AGENT_ID } from "@/lib/agent/agent-ids";
import { fetchToolJson, runToolHandler } from "@/lib/agent/tool-kernel";

// Client-side specification actions (016-unified-agents FR-006), over /api/specs
// (jailed to specs/ + .specify/). They let an active-personality agent — Build
// Studio — author specs directly instead of being forced to delegate. Mirrors the
// server-side SPEC_TOOLS (read_spec/write_spec/…) used when an agent is delegated to.
// Gated by the agent's allowlist via the shim import above.
//
// Branch coupling (020): reads/writes carry the conversation's active feature
// branch so specs land on — and are read from — that branch's worktree spec store,
// the same branch the Developer builds. No branch → base checkout.

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

/** GET a spec artifact (branch-aware). Kernel-safe: never throws. */
function readSpec(tool: string, path: string, branch: string | undefined, signal: AbortSignal) {
  const qs = `path=${encodeURIComponent(path)}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`;
  return fetchToolJson(tool, `/api/specs?${qs}`, { signal });
}

/** PUT (create/overwrite) a spec artifact (branch-aware). Kernel-safe: never throws. */
function putSpec(tool: string, path: string, content: string, branch: string | undefined, signal: AbortSignal) {
  return fetchToolJson(tool, "/api/specs", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content, ...(branch ? { branch } : {}) }),
    signal,
  });
}

export function SpecActions({ agentId = DEFAULT_AGENT_ID }: { agentId?: string }) {
  // Read the active conversation's feature branch through a ref so the (once-created)
  // action handlers always send the CURRENT selection, not a stale closure value.
  const activeConversation = useActiveConversation(agentId);
  const branchRef = useRef(activeConversation?.activeFeatureBranch);
  useEffect(() => {
    branchRef.current = activeConversation?.activeFeatureBranch;
  }, [activeConversation?.activeFeatureBranch]);
  useCopilotAction({
    name: "spec_list",
    description: "List specification artifacts across the spec stores (e.g. 'bos-system-specs', 'user-specs'): feature folders and their files. Paths returned are store-prefixed (`<storeId>/<feature>/<file>`).",
    parameters: [],
    handler: () =>
      runToolHandler("spec_list", async ({ signal }) => {
        const out = await fetchToolJson("spec_list", "/api/specs", { signal });
        if (!out.ok) return out.error;
        const res = out.data as { tree?: TreeNode[]; specs?: { id: string; title?: string }[] };
        const files = flattenFiles(res.tree);
        const specs = (res.specs ?? []).map((s: { id: string; title?: string }) => ({ id: s.id, title: s.title }));
        return JSON.stringify({ specs, files });
      }),
  });

  useCopilotAction({
    name: "spec_read",
    description: "Read a specification artifact by its STORE-PREFIXED path, e.g. 'bos-system-specs/016-unified-agents/spec.md' or 'bos-system-specs/.specify/memory/constitution.md'.",
    parameters: [{ name: "path", type: "string", description: "Store-prefixed artifact path, e.g. 'user-specs/003-x/spec.md'", required: true }],
    handler: ({ path }) =>
      runToolHandler("spec_read", async ({ signal }) => {
        const out = await readSpec("spec_read", String(path ?? ""), branchRef.current, signal);
        if (!out.ok) return out.error;
        const res = out.data as { error?: string; content?: unknown };
        return res.error ? `Error: ${res.error}` : String(res.content ?? "");
      }),
  });

  useCopilotAction({
    name: "spec_write",
    description: "Create or overwrite a specification artifact by STORE-PREFIXED path. New specs go in the user store; writes go to the conversation's active feature branch when one is set. Provide the FULL file content.",
    parameters: [
      { name: "path", type: "string", description: "Store-prefixed artifact path, e.g. 'user-specs/003-x/spec.md'", required: true },
      { name: "content", type: "string", description: "Full file content", required: true },
    ],
    handler: ({ path, content }) =>
      runToolHandler("spec_write", async ({ signal }) => {
        const out = await putSpec("spec_write", String(path ?? ""), String(content ?? ""), branchRef.current, signal);
        if (!out.ok) return out.error;
        const res = out.data as { error?: string; path?: string };
        return res.error ? `Error: ${res.error}` : `Wrote ${res.path}`;
      }),
  });

  useCopilotAction({
    name: "spec_edit",
    description: "Find-and-replace within a specification artifact. The find text must appear EXACTLY once.",
    parameters: [
      { name: "path", type: "string", description: "Artifact path", required: true },
      { name: "find", type: "string", description: "Exact text to replace", required: true },
      { name: "replace", type: "string", description: "Replacement text", required: true },
    ],
    handler: ({ path, find, replace }) =>
      runToolHandler("spec_edit", async ({ signal }) => {
        const p = String(path ?? "");
        const branch = branchRef.current;
        const curOut = await readSpec("spec_edit", p, branch, signal);
        if (!curOut.ok) return curOut.error;
        const cur = curOut.data as { error?: string; content?: unknown };
        if (cur.error) return `Error: ${cur.error}`;
        const content = String(cur.content ?? "");
        const f = String(find ?? "");
        const occurrences = f ? content.split(f).length - 1 : 0;
        if (occurrences === 0) return `Error: "find" text not found in ${p}.`;
        if (occurrences > 1) return `Error: "find" text appears ${occurrences} times in ${p}; make it unique.`;
        const next = content.replace(f, String(replace ?? ""));
        const out = await putSpec("spec_edit", p, next, branch, signal);
        if (!out.ok) return out.error;
        const res = out.data as { error?: string; path?: string };
        return res.error ? `Error: ${res.error}` : `Edited ${res.path}`;
      }),
  });

  useCopilotAction({
    name: "spec_search",
    description: "Search specification artifacts by path/name (case-insensitive substring). Returns matching artifact paths.",
    parameters: [{ name: "query", type: "string", description: "Search text", required: true }],
    handler: ({ query }) =>
      runToolHandler("spec_search", async ({ signal }) => {
        const q = String(query ?? "").toLowerCase();
        const out = await fetchToolJson("spec_search", "/api/specs", { signal });
        if (!out.ok) return out.error;
        const res = out.data as { tree?: TreeNode[] };
        return JSON.stringify(flattenFiles(res.tree).filter((p) => p.toLowerCase().includes(q)));
      }),
  });

  useCopilotAction({
    name: "spec_template_read",
    description: "Read a spec-kit template or command prompt from the engine at .specify/templates (e.g. 'spec-template.md', 'plan-template.md', 'commands/specify.md'). Read-only.",
    parameters: [{ name: "path", type: "string", description: "Template path relative to .specify/templates", required: true }],
    handler: ({ path }) =>
      runToolHandler("spec_template_read", async ({ signal }) => {
        const out = await fetchToolJson(
          "spec_template_read",
          `/api/specs/templates?path=${encodeURIComponent(String(path ?? ""))}`,
          { signal },
        );
        if (!out.ok) return out.error;
        const res = out.data as { error?: string; content?: unknown };
        return res.error ? `Error: ${res.error}` : String(res.content ?? "");
      }),
  });

  useCopilotAction({
    name: "spec_template_list",
    description: "List available spec-kit templates/command prompts under .specify/templates (optionally a subdir like 'commands').",
    parameters: [{ name: "path", type: "string", description: "Subdirectory under .specify/templates (optional)", required: false }],
    handler: ({ path }) =>
      runToolHandler("spec_template_list", async ({ signal }) => {
        const q = path ? `?list=${encodeURIComponent(String(path))}` : "";
        const out = await fetchToolJson("spec_template_list", `/api/specs/templates${q}`, { signal });
        if (!out.ok) return out.error;
        const res = out.data as { error?: string; entries?: unknown };
        return res.error ? `Error: ${res.error}` : JSON.stringify(res.entries);
      }),
  });

  return null;
}
