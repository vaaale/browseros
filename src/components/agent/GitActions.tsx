"use client";

import { useCopilotAction } from "@/components/agent/gated-action";

// Git tooling for the "minimize blast radius" policy. Before modifying BOS
// itself, the assistant starts a feature branch and stages changed files so the
// work can be rolled back. (No commit/push — the user reviews and commits.)
export function GitActions() {
  useCopilotAction({
    name: "gitStatus",
    description:
      "Show git status of the BOS repo: the main checkout's branch + changed files, AND any pending self-modification `candidate` (a built-but-not-yet-active version living in an isolated worktree). If `candidate` is present, a delegated edit lives THERE (committed) — the main checkout will look clean, so do NOT re-apply the change in place; the user previews/promotes the candidate from the top-bar Active ▾ menu.",
    parameters: [],
    handler: async () => {
      const res = await fetch("/api/system/git").then((r) => r.json());
      return res.error ? `Error: ${res.error}` : JSON.stringify(res);
    },
  });

  useCopilotAction({
    name: "startFeatureBranch",
    description:
      "Create/switch to a feature branch before modifying BOS itself (apps/features/source). Branch is namespaced as bos/<name>.",
    parameters: [{ name: "name", type: "string", description: "Short feature name", required: true }],
    handler: async ({ name }) => {
      const res = await fetch("/api/system/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "branch", name }),
      }).then((r) => r.json());
      return res.error ? `Error: ${res.error}` : `On feature branch "${res.branch}".`;
    },
  });

  useCopilotAction({
    name: "stageChanges",
    description: "Stage changed files (git add) after modifying BOS, so the work is captured and reversible.",
    parameters: [{ name: "paths", type: "string[]", description: "Repo-relative file paths to stage", required: true }],
    handler: async ({ paths }) => {
      const res = await fetch("/api/system/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "stage", paths }),
      }).then((r) => r.json());
      return res.error ? `Error: ${res.error}` : `Staged ${res.staged} file(s).`;
    },
  });

  return null;
}
