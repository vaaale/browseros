"use client";

import { useCopilotAction } from "@copilotkit/react-core";
import { useEffect } from "react";
import { encodeNested } from "@/lib/agent/nested-events";

// Registers the 7 Workflow Manager tools and ensures the iframe app exists.
// All handlers proxy to /api/workflows/* (server stores live behind the API
// boundary; client never imports them directly).
export function WorkflowActions() {
  // Touch the workflows API once on mount so the server installs the iframe app.
  useEffect(() => {
    void fetch("/api/workflows").catch(() => {});
  }, []);

  useCopilotAction({
    name: "createWorkflow",
    description:
      "Generate and persist a new workflow from a natural-language task description. Returns the new workflow's id and a summary.",
    parameters: [
      { name: "taskDescription", type: "string", description: "What the workflow should accomplish", required: true },
    ],
    handler: async ({ taskDescription }) => {
      const res = await fetch("/api/workflows/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: taskDescription }),
      }).then((r) => r.json());
      if (res.error) return `Error: ${res.error}`;
      const wf = res.workflow;
      return `Created workflow "${wf.name}" (id: ${wf.id}) with ${wf.steps.length} step(s).\n\nValidation: ${res.validation?.ok ? "ok" : "errors: " + (res.validation?.errors ?? []).join("; ")}`;
    },
  });

  useCopilotAction({
    name: "modifyWorkflow",
    description:
      "Apply a JSON-merge patch to an existing workflow, then re-validate. The 'changes' parameter must be a JSON object representing the patch.",
    parameters: [
      { name: "workflowId", type: "string", description: "Workflow id", required: true },
      { name: "changes", type: "object", description: "JSON merge patch", required: true },
    ],
    handler: async ({ workflowId, changes }) => {
      const res = await fetch(`/api/workflows?id=${encodeURIComponent(workflowId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes ?? {}),
      }).then((r) => r.json());
      if (res.error) return `Error: ${res.error}`;
      const v = await fetch("/api/workflows/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: workflowId }),
      }).then((r) => r.json());
      return `Modified workflow ${workflowId}. Steps: ${res.workflow.steps.length}, agents: ${res.workflow.agents.length}.\nValidation: ${v.ok ? "ok" : "errors: " + (v.errors ?? []).join("; ")}`;
    },
  });

  useCopilotAction({
    name: "runWorkflow",
    description: "Execute a workflow. Streams step events; returns a summary plus the event tree.",
    parameters: [{ name: "workflowId", type: "string", description: "Workflow id", required: true }],
    handler: async ({ workflowId }) => {
      const events: { tool: string; input?: unknown }[] = [];
      let output = "";
      try {
        const res = await fetch("/api/workflows/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: workflowId }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          return `Error: ${j.error ?? res.statusText}`;
        }
        if (!res.body) return "Error: no stream body";
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let final = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const s = line.trim();
            if (!s) continue;
            let ev: { type: string; stepId?: string; attempt?: number; error?: string; payload?: unknown };
            try { ev = JSON.parse(s); } catch { continue; }
            events.push({ tool: ev.type, input: { stepId: ev.stepId, attempt: ev.attempt, error: ev.error } });
            if (ev.type === "workflow.complete") final = "completed";
            else if (ev.type === "workflow.fail") final = `failed: ${ev.error ?? "unknown"}`;
            else if (ev.type === "workflow.cancel") final = "cancelled";
          }
        }
        output = `Workflow ${workflowId} ${final || "ended"}.`;
      } catch (err) {
        output = `Error: ${(err as Error).message}`;
      }
      const summary = `${output}\n\nEvents: ${events.length}`;
      return summary + encodeNested({ events, output });
    },
  });

  useCopilotAction({
    name: "getStatus",
    description: "Return the current execution state of a workflow and per-step statuses.",
    parameters: [{ name: "workflowId", type: "string", description: "Workflow id", required: true }],
    handler: async ({ workflowId }) => {
      const res = await fetch(`/api/workflows/status?id=${encodeURIComponent(workflowId)}`).then((r) => r.json());
      if (res.error) return `Error: ${res.error}`;
      return JSON.stringify(res.status, null, 2);
    },
  });

  useCopilotAction({
    name: "cancelWorkflow",
    description: "Cancel a running workflow. In-progress steps are marked cancelled and the scheduler halts.",
    parameters: [{ name: "workflowId", type: "string", description: "Workflow id", required: true }],
    handler: async ({ workflowId }) => {
      const res = await fetch("/api/workflows/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: workflowId }),
      }).then((r) => r.json());
      return res.cancelled ? `Cancelled workflow ${workflowId}.` : `Workflow ${workflowId} was not running.`;
    },
  });

  useCopilotAction({
    name: "exportWorkflow",
    description: "Return the workflow's full JSON as a string.",
    parameters: [{ name: "workflowId", type: "string", description: "Workflow id", required: true }],
    handler: async ({ workflowId }) => {
      const res = await fetch(`/api/workflows?id=${encodeURIComponent(workflowId)}`).then((r) => r.json());
      if (res.error) return `Error: ${res.error}`;
      return JSON.stringify(res.workflow, null, 2);
    },
  });

  useCopilotAction({
    name: "validateWorkflow",
    description: "Validate a workflow (DAG acyclic, agents exist, dependencies resolvable). Returns { ok, errors[], warnings[] }.",
    parameters: [{ name: "workflowId", type: "string", description: "Workflow id", required: true }],
    handler: async ({ workflowId }) => {
      const res = await fetch("/api/workflows/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: workflowId }),
      }).then((r) => r.json());
      return JSON.stringify(res, null, 2);
    },
  });

  return null;
}
