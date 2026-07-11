import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { getWorkflow, saveWorkflow, getStatus } from "@/lib/workflows/store";
import { generateWorkflowFromTask } from "@/lib/workflows/generate";
import { validateWorkflow } from "@/lib/workflows/validate";
import { runWorkflowStream, cancelWorkflow } from "@/lib/workflows/runner";
import { ensureWorkflowApp } from "@/lib/workflows/install";
import { encodeNested } from "@/lib/agent/nested-events";
import type { Workflow } from "@/lib/workflows/types";

// The 7 Workflow Manager tools, ported from WorkflowActions.tsx. workflow_run
// streams step events through ctx.onEvent (each event also resets the loop's
// idle timeout, so long but chatty runs are never cut off) and returns the same
// summary + encodeNested payload the old NDJSON handler produced.

function deepMerge<T>(target: T, patch: unknown): T {
  if (patch == null || typeof patch !== "object") return target;
  if (Array.isArray(patch)) return patch as unknown as T;
  const out: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k];
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
      out[k] = deepMerge(cur, v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export function workflowTools(): Record<string, AssistantTool> {
  return {
    workflow_create: serverTool(
      "workflow_create",
      "Generate and persist a new workflow from a natural-language task description. Returns the new workflow's id and a summary.",
      schema({ taskDescription: p.str("What the workflow should accomplish") }, ["taskDescription"]),
      async (input) => {
        const task = String(input.taskDescription ?? "").trim();
        if (!task) return "Error: workflow_create: taskDescription is required — describe what the workflow should accomplish.";
        await ensureWorkflowApp().catch(() => {});
        const wf = await generateWorkflowFromTask(task);
        const saved = await saveWorkflow(wf);
        const validation = await validateWorkflow(saved);
        return `Created workflow "${saved.name}" (id: ${saved.id}) with ${saved.steps.length} step(s).\n\nValidation: ${validation.ok ? "ok" : "errors: " + (validation.errors ?? []).join("; ")}`;
      },
    ),

    workflow_modify: serverTool(
      "workflow_modify",
      "Apply a JSON-merge patch to an existing workflow, then re-validate. The 'changes' parameter must be a JSON object representing the patch.",
      schema(
        {
          workflowId: p.str("Workflow id"),
          changes: p.obj("JSON merge patch"),
        },
        ["workflowId", "changes"],
      ),
      async (input) => {
        const id = String(input.workflowId ?? "");
        const current = await getWorkflow(id);
        if (!current) return `Error: No workflow "${id}"`;
        const merged = deepMerge(current, input.changes ?? {});
        const saved = await saveWorkflow({ ...merged, id } as Workflow);
        const v = await validateWorkflow(saved);
        return `Modified workflow ${id}. Steps: ${saved.steps.length}, agents: ${saved.agents.length}.\nValidation: ${v.ok ? "ok" : "errors: " + (v.errors ?? []).join("; ")}`;
      },
    ),

    workflow_run: serverTool(
      "workflow_run",
      "Execute a workflow. Streams step events; returns a summary plus the event tree.",
      schema({ workflowId: p.str("Workflow id") }, ["workflowId"]),
      async (input, ctx) => {
        const id = String(input.workflowId ?? "");
        const wf = await getWorkflow(id);
        if (!wf) return `Error: No workflow "${id}"`;
        const validation = await validateWorkflow(wf);
        if (!validation.ok) {
          return `Error: workflow_run: validation failed — ${(validation.errors ?? []).join("; ") || "fix the workflow with workflow_modify and retry"}`;
        }
        const events: { tool: string; input?: unknown }[] = [];
        let final = "";
        try {
          for await (const ev of runWorkflowStream(wf, { conversationId: ctx.conversationId })) {
            ctx.onEvent(ev);
            const typed = ev as { type: string; stepId?: string; attempt?: number; error?: string };
            events.push({ tool: typed.type, input: { stepId: typed.stepId, attempt: typed.attempt, error: typed.error } });
            if (typed.type === "workflow.complete") final = "completed";
            else if (typed.type === "workflow.fail") final = `failed: ${typed.error ?? "unknown"}`;
            else if (typed.type === "workflow.cancel") final = "cancelled";
          }
        } catch (err) {
          final = `failed: ${(err as Error).message}`;
          events.push({ tool: "workflow.fail", input: { error: (err as Error).message } });
        }
        const output = `Workflow ${id} ${final || "ended"}.`;
        const summary = `${output}\n\nEvents: ${events.length}`;
        return summary + encodeNested({ events, output });
      },
    ),

    workflow_status: serverTool(
      "workflow_status",
      "Return the current execution state of a workflow and per-step statuses.",
      schema({ workflowId: p.str("Workflow id") }, ["workflowId"]),
      async (input) => {
        const id = String(input.workflowId ?? "");
        const status = await getStatus(id);
        if (!status) return `Error: No workflow "${id}"`;
        return JSON.stringify(status, null, 2);
      },
    ),

    workflow_cancel: serverTool(
      "workflow_cancel",
      "Cancel a running workflow. In-progress steps are marked cancelled and the scheduler halts.",
      schema({ workflowId: p.str("Workflow id") }, ["workflowId"]),
      async (input) => {
        const id = String(input.workflowId ?? "");
        const cancelled = cancelWorkflow(id);
        return cancelled ? `Cancelled workflow ${id}.` : `Workflow ${id} was not running.`;
      },
    ),

    workflow_export: serverTool(
      "workflow_export",
      "Return the workflow's full JSON as a string.",
      schema({ workflowId: p.str("Workflow id") }, ["workflowId"]),
      async (input) => {
        const id = String(input.workflowId ?? "");
        const wf = await getWorkflow(id);
        if (!wf) return `Error: No workflow "${id}"`;
        return JSON.stringify(wf, null, 2);
      },
    ),

    workflow_validate: serverTool(
      "workflow_validate",
      "Validate a workflow (DAG acyclic, agents exist, dependencies resolvable). Returns { ok, errors[], warnings[] }.",
      schema({ workflowId: p.str("Workflow id") }, ["workflowId"]),
      async (input) => {
        const id = String(input.workflowId ?? "");
        const wf = await getWorkflow(id);
        if (!wf) return `Error: No workflow "${id}"`;
        return JSON.stringify(await validateWorkflow(wf), null, 2);
      },
    ),
  };
}
