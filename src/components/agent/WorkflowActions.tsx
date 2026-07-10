"use client";

import { useCopilotAction } from "@copilotkit/react-core";
import { useEffect } from "react";
import { encodeNested } from "@/lib/agent/nested-events";
import { fetchToolJson, getToolTimeoutMs, readNdjsonStream, runToolHandler } from "@/lib/agent/tool-kernel";

// Registers the 7 Workflow Manager tools and ensures the iframe app exists.
// All handlers proxy to /api/workflows/* (server stores live behind the API
// boundary; client never imports them directly). Every handler runs inside
// runToolHandler (the tool kernel) so it always settles and surfaces failures
// as in-band `Error: …` strings; the streaming workflow_run additionally uses
// an idle (silence) timeout via readNdjsonStream.
export function WorkflowActions() {
  // Touch the workflows API once on mount so the server installs the iframe app.
  useEffect(() => {
    void fetch("/api/workflows").catch(() => {});
  }, []);

  useCopilotAction({
    name: "workflow_create",
    description:
      "Generate and persist a new workflow from a natural-language task description. Returns the new workflow's id and a summary.",
    parameters: [
      { name: "taskDescription", type: "string", description: "What the workflow should accomplish", required: true },
    ],
    handler: ({ taskDescription }) =>
      runToolHandler("workflow_create", async ({ signal }) => {
        const out = await fetchToolJson("workflow_create", "/api/workflows/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task: taskDescription }),
          signal,
        });
        if (!out.ok) return out.error;
        const res = out.data as {
          error?: string;
          workflow?: { name: string; id: string; steps: unknown[] };
          validation?: { ok?: boolean; errors?: string[] };
        };
        if (res.error) return `Error: ${res.error}`;
        const wf = res.workflow!;
        return `Created workflow "${wf.name}" (id: ${wf.id}) with ${wf.steps.length} step(s).\n\nValidation: ${res.validation?.ok ? "ok" : "errors: " + (res.validation?.errors ?? []).join("; ")}`;
      }),
  });

  useCopilotAction({
    name: "workflow_modify",
    description:
      "Apply a JSON-merge patch to an existing workflow, then re-validate. The 'changes' parameter must be a JSON object representing the patch.",
    parameters: [
      { name: "workflowId", type: "string", description: "Workflow id", required: true },
      { name: "changes", type: "object", description: "JSON merge patch", required: true },
    ],
    handler: ({ workflowId, changes }) =>
      runToolHandler("workflow_modify", async ({ signal }) => {
        const patched = await fetchToolJson("workflow_modify", `/api/workflows?id=${encodeURIComponent(workflowId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(changes ?? {}),
          signal,
        });
        if (!patched.ok) return patched.error;
        const res = patched.data as { error?: string; workflow?: { steps: unknown[]; agents: unknown[] } };
        if (res.error) return `Error: ${res.error}`;
        const validated = await fetchToolJson("workflow_modify", "/api/workflows/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: workflowId }),
          signal,
        });
        if (!validated.ok) return validated.error;
        const v = validated.data as { ok?: boolean; errors?: string[] };
        return `Modified workflow ${workflowId}. Steps: ${res.workflow!.steps.length}, agents: ${res.workflow!.agents.length}.\nValidation: ${v.ok ? "ok" : "errors: " + (v.errors ?? []).join("; ")}`;
      }),
  });

  useCopilotAction({
    name: "workflow_run",
    description: "Execute a workflow. Streams step events; returns a summary plus the event tree.",
    parameters: [{ name: "workflowId", type: "string", description: "Workflow id", required: true }],
    handler: ({ workflowId }) =>
      runToolHandler(
        "workflow_run",
        async ({ signal }) => {
          const events: { tool: string; input?: unknown }[] = [];
          const res = await fetch("/api/workflows/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: workflowId }),
            signal,
          });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            return `Error: ${j.error ?? res.statusText}`;
          }
          // Stream step events with an idle (silence) timeout: the deadline
          // resets on every chunk, so a long but chatty run is never cut off.
          let final = "";
          const stream = await readNdjsonStream(
            "workflow_run",
            res,
            (s) => {
              let ev: { type: string; stepId?: string; attempt?: number; error?: string; payload?: unknown };
              try { ev = JSON.parse(s); } catch { return; }
              events.push({ tool: ev.type, input: { stepId: ev.stepId, attempt: ev.attempt, error: ev.error } });
              if (ev.type === "workflow.complete") final = "completed";
              else if (ev.type === "workflow.fail") final = `failed: ${ev.error ?? "unknown"}`;
              else if (ev.type === "workflow.cancel") final = "cancelled";
            },
            getToolTimeoutMs(),
            "the workflow stream went silent; the workflow may still be executing — use workflow_status before re-running",
          );
          // Idle abort: prefer a terminal event that arrived before the
          // silence; otherwise return the truthful abandonment error.
          if (!stream.ok && !final) return stream.error;
          const output = `Workflow ${workflowId} ${final || "ended"}.`;
          const summary = `${output}\n\nEvents: ${events.length}`;
          return summary + encodeNested({ events, output });
        },
        {
          // Last-resort backstop: a healthy workflow may run far beyond one
          // idle window, so the outer budget is 6× the configured timeout.
          timeoutMs: getToolTimeoutMs() * 6,
          timeoutHint: "the workflow may still be executing — use workflow_status before re-running",
        },
      ),
  });

  useCopilotAction({
    name: "workflow_status",
    description: "Return the current execution state of a workflow and per-step statuses.",
    parameters: [{ name: "workflowId", type: "string", description: "Workflow id", required: true }],
    handler: ({ workflowId }) =>
      runToolHandler("workflow_status", async ({ signal }) => {
        const out = await fetchToolJson("workflow_status", `/api/workflows/status?id=${encodeURIComponent(workflowId)}`, { signal });
        if (!out.ok) return out.error;
        if (out.data.error) return `Error: ${out.data.error}`;
        return JSON.stringify(out.data.status, null, 2);
      }),
  });

  useCopilotAction({
    name: "workflow_cancel",
    description: "Cancel a running workflow. In-progress steps are marked cancelled and the scheduler halts.",
    parameters: [{ name: "workflowId", type: "string", description: "Workflow id", required: true }],
    handler: ({ workflowId }) =>
      runToolHandler("workflow_cancel", async ({ signal }) => {
        const out = await fetchToolJson("workflow_cancel", "/api/workflows/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: workflowId }),
          signal,
        });
        if (!out.ok) return out.error;
        return out.data.cancelled ? `Cancelled workflow ${workflowId}.` : `Workflow ${workflowId} was not running.`;
      }),
  });

  useCopilotAction({
    name: "workflow_export",
    description: "Return the workflow's full JSON as a string.",
    parameters: [{ name: "workflowId", type: "string", description: "Workflow id", required: true }],
    handler: ({ workflowId }) =>
      runToolHandler("workflow_export", async ({ signal }) => {
        const out = await fetchToolJson("workflow_export", `/api/workflows?id=${encodeURIComponent(workflowId)}`, { signal });
        if (!out.ok) return out.error;
        if (out.data.error) return `Error: ${out.data.error}`;
        return JSON.stringify(out.data.workflow, null, 2);
      }),
  });

  useCopilotAction({
    name: "workflow_validate",
    description: "Validate a workflow (DAG acyclic, agents exist, dependencies resolvable). Returns { ok, errors[], warnings[] }.",
    parameters: [{ name: "workflowId", type: "string", description: "Workflow id", required: true }],
    handler: ({ workflowId }) =>
      runToolHandler("workflow_validate", async ({ signal }) => {
        const out = await fetchToolJson("workflow_validate", "/api/workflows/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: workflowId }),
          signal,
        });
        if (!out.ok) return out.error;
        return JSON.stringify(out.data, null, 2);
      }),
  });

  return null;
}
