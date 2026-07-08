import "server-only";
import * as vfs from "@/os/vfs";
import type {
  ExecutionEvent,
  StepRuntimeState,
  Workflow,
  WorkflowRuntimeStatus,
  WorkflowState,
} from "./types";

const ROOT = "/Workflows";
const RESULTS = `${ROOT}/results`;

function workflowPath(id: string): string {
  return `${ROOT}/${id}-workflow.json`;
}

function logPath(id: string): string {
  return `${ROOT}/${id}-execution-log.json`;
}

function slugify(name: string): string {
  return (
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
    `workflow-${Date.now().toString(36)}`
  );
}

async function ensureRoot(): Promise<void> {
  await vfs.mkdir(ROOT);
  await vfs.mkdir(RESULTS);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    const txt = await vfs.readText(path);
    return JSON.parse(txt) as T;
  } catch {
    return undefined;
  }
}

export function generateWorkflowId(name: string): string {
  return `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function listWorkflows(): Promise<Workflow[]> {
  await ensureRoot();
  let entries: { name: string; path: string; type: string }[] = [];
  try {
    entries = await vfs.list(ROOT);
  } catch {
    return [];
  }
  const out: Workflow[] = [];
  for (const e of entries) {
    if (e.type !== "file" || !e.name.endsWith("-workflow.json")) continue;
    const wf = await readJson<Workflow>(e.path);
    if (wf && wf.id) out.push(wf);
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export async function getWorkflow(id: string): Promise<Workflow | undefined> {
  await ensureRoot();
  return readJson<Workflow>(workflowPath(id));
}

export async function saveWorkflow(input: Workflow): Promise<Workflow> {
  await ensureRoot();
  const now = Date.now();
  const wf: Workflow = {
    ...input,
    id: input.id || generateWorkflowId(input.name || "workflow"),
    version: input.version ?? 1,
    agents: Array.isArray(input.agents) ? input.agents : [],
    steps: Array.isArray(input.steps) ? input.steps : [],
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  };
  await vfs.writeText(workflowPath(wf.id), JSON.stringify(wf, null, 2));
  return wf;
}

export async function deleteWorkflow(id: string): Promise<void> {
  await ensureRoot();
  await vfs.remove(workflowPath(id)).catch(() => {});
  await vfs.remove(logPath(id)).catch(() => {});
}

export async function appendExecutionLog(id: string, event: ExecutionEvent): Promise<void> {
  await ensureRoot();
  const existing = (await readJson<ExecutionEvent[]>(logPath(id))) ?? [];
  existing.push(event);
  await vfs.writeText(logPath(id), JSON.stringify(existing, null, 2));
}

export async function clearExecutionLog(id: string): Promise<void> {
  await ensureRoot();
  await vfs.writeText(logPath(id), "[]");
}

export async function getExecutionLog(id: string): Promise<ExecutionEvent[]> {
  return (await readJson<ExecutionEvent[]>(logPath(id))) ?? [];
}

// In-memory runtime status. Single-user/single-process is fine for BOS.
const RUNTIME = new Map<string, WorkflowRuntimeStatus>();

export function getRuntimeStatus(id: string): WorkflowRuntimeStatus | undefined {
  return RUNTIME.get(id);
}

export function setRuntimeStatus(status: WorkflowRuntimeStatus): void {
  RUNTIME.set(status.workflowId, status);
}

export function updateStepRuntime(
  workflowId: string,
  stepId: string,
  patch: Partial<StepRuntimeState>,
): void {
  const cur = RUNTIME.get(workflowId);
  if (!cur) return;
  const step = cur.steps[stepId] ?? { status: "queued", attempts: 0 };
  cur.steps[stepId] = { ...step, ...patch };
  RUNTIME.set(workflowId, cur);
}

export function updateWorkflowState(workflowId: string, state: WorkflowState): void {
  const cur = RUNTIME.get(workflowId);
  if (!cur) return;
  cur.state = state;
  if (state === "RUNNING" && !cur.startedAt) cur.startedAt = Date.now();
  if (state === "COMPLETED" || state === "FAILED" || state === "CANCELLED") {
    cur.endedAt = Date.now();
  }
  RUNTIME.set(workflowId, cur);
}

export async function getStatus(id: string): Promise<WorkflowRuntimeStatus | undefined> {
  const inMemory = RUNTIME.get(id);
  if (inMemory) return inMemory;
  // Reconstruct a minimal status from disk so the UI can show last-run history.
  const wf = await getWorkflow(id);
  if (!wf) return undefined;
  const log = await getExecutionLog(id);
  const steps: Record<string, StepRuntimeState> = {};
  for (const s of wf.steps) steps[s.id] = { status: "queued", attempts: 0 };
  let state: WorkflowState = "CREATED";
  for (const ev of log) {
    if (ev.type === "step.start" && ev.stepId) {
      steps[ev.stepId] = { ...(steps[ev.stepId] ?? { status: "queued", attempts: 0 }), status: "running", attempts: ev.attempt ?? 1, startedAt: ev.ts };
    } else if (ev.type === "step.retry" && ev.stepId) {
      const s = steps[ev.stepId] ?? { status: "queued", attempts: 0 };
      steps[ev.stepId] = { ...s, status: "retrying", attempts: ev.attempt ?? s.attempts, lastError: ev.error };
    } else if (ev.type === "step.complete" && ev.stepId) {
      steps[ev.stepId] = { ...(steps[ev.stepId] ?? { status: "queued", attempts: 0 }), status: "complete", endedAt: ev.ts, output: ev.payload };
    } else if (ev.type === "step.fail" && ev.stepId) {
      steps[ev.stepId] = { ...(steps[ev.stepId] ?? { status: "queued", attempts: 0 }), status: "failed", endedAt: ev.ts, lastError: ev.error };
    } else if (ev.type === "workflow.start") {
      state = "RUNNING";
    } else if (ev.type === "workflow.complete") {
      state = "COMPLETED";
    } else if (ev.type === "workflow.fail") {
      state = "FAILED";
    } else if (ev.type === "workflow.cancel") {
      state = "CANCELLED";
    }
  }
  return { workflowId: id, state, steps };
}
