import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import { calculateNextRun, validateScheduleConfig } from "./schedule";
import type { Task, TaskExecution, TaskInput, TaskUpdate } from "./types";

// All scheduler state lives here so it survives restarts.
function schedulerDir(): string {
  return path.join(dataDir(), "scheduler");
}
function tasksFile(): string {
  return path.join(schedulerDir(), "tasks.json");
}
function executionsDir(): string {
  return path.join(schedulerDir(), "executions");
}
function executionFile(taskId: string): string {
  return path.join(executionsDir(), `${taskId}.json`);
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

export async function listTasks(): Promise<Task[]> {
  return readJson<Task[]>(tasksFile(), []);
}

export async function getTask(taskId: string): Promise<Task | null> {
  const tasks = await listTasks();
  return tasks.find((t) => t.id === taskId) ?? null;
}

async function writeAllTasks(tasks: Task[]): Promise<void> {
  await fs.mkdir(schedulerDir(), { recursive: true });
  await writeFileAtomic(tasksFile(), JSON.stringify(tasks, null, 2));
}

export async function createTask(input: TaskInput): Promise<Task> {
  validateScheduleConfig(input.scheduleConfig);
  const now = new Date().toISOString();
  const nextRunAt = calculateNextRun(input.scheduleConfig);
  const task: Task = {
    id: randomUUID(),
    name: input.name.trim() || "Untitled Task",
    prompt: input.prompt,
    agentId: input.agentId,
    scheduleType: input.scheduleConfig.type,
    scheduleConfig: input.scheduleConfig,
    status: "active",
    nextRunAt,
    createdAt: now,
    updatedAt: now,
    deleteAfterExecution: !!input.deleteAfterExecution,
  };
  const tasks = await listTasks();
  tasks.push(task);
  await writeAllTasks(tasks);
  return task;
}

export async function updateTask(taskId: string, updates: TaskUpdate): Promise<Task | null> {
  if (updates.scheduleConfig) validateScheduleConfig(updates.scheduleConfig);
  const tasks = await listTasks();
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return null;
  const prev = tasks[idx];
  const next: Task = {
    ...prev,
    ...(updates.name !== undefined ? { name: updates.name } : {}),
    ...(updates.prompt !== undefined ? { prompt: updates.prompt } : {}),
    ...(updates.agentId !== undefined ? { agentId: updates.agentId } : {}),
    ...(updates.deleteAfterExecution !== undefined
      ? { deleteAfterExecution: updates.deleteAfterExecution }
      : {}),
    updatedAt: new Date().toISOString(),
  };
  if (updates.scheduleConfig) {
    next.scheduleConfig = updates.scheduleConfig;
    next.scheduleType = updates.scheduleConfig.type;
    if (next.status === "active") {
      next.nextRunAt = calculateNextRun(updates.scheduleConfig, next.lastExecutedAt);
    }
  }
  tasks[idx] = next;
  await writeAllTasks(tasks);
  return next;
}

export async function deleteTask(taskId: string): Promise<boolean> {
  const tasks = await listTasks();
  const remaining = tasks.filter((t) => t.id !== taskId);
  if (remaining.length === tasks.length) return false;
  await writeAllTasks(remaining);
  await fs.rm(executionFile(taskId), { force: true });
  return true;
}

export async function pauseTask(taskId: string): Promise<Task | null> {
  const tasks = await listTasks();
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return null;
  tasks[idx] = { ...tasks[idx], status: "paused", nextRunAt: null, updatedAt: new Date().toISOString() };
  await writeAllTasks(tasks);
  return tasks[idx];
}

export async function resumeTask(taskId: string): Promise<Task | null> {
  const tasks = await listTasks();
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return null;
  const prev = tasks[idx];
  if (prev.status === "completed") return prev;
  tasks[idx] = {
    ...prev,
    status: "active",
    nextRunAt: calculateNextRun(prev.scheduleConfig, prev.lastExecutedAt),
    updatedAt: new Date().toISOString(),
  };
  await writeAllTasks(tasks);
  return tasks[idx];
}

/**
 * Commit the result of an execution: append to history, update nextRunAt, mark
 * completed one-time tasks (or delete them if configured). Kept internal to
 * storage so callers don't have to juggle both files.
 */
export async function recordExecution(
  taskId: string,
  exec: Omit<TaskExecution, "id" | "taskId">,
): Promise<Task | null> {
  const tasks = await listTasks();
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return null;
  const prev = tasks[idx];
  const execution: TaskExecution = {
    id: randomUUID(),
    taskId,
    ...exec,
  };
  await appendExecution(execution);

  const now = new Date().toISOString();
  const nextRunAt =
    prev.scheduleType === "one-time"
      ? null
      : calculateNextRun(prev.scheduleConfig, execution.executedAt);

  let next: Task = {
    ...prev,
    lastExecutedAt: execution.executedAt,
    nextRunAt,
    updatedAt: now,
  };
  if (prev.scheduleType === "one-time" && exec.status === "success") {
    next.status = "completed";
  }

  if (next.status === "completed" && prev.deleteAfterExecution) {
    const remaining = tasks.filter((t) => t.id !== taskId);
    await writeAllTasks(remaining);
    return next;
  }

  tasks[idx] = next;
  await writeAllTasks(tasks);
  return next;
}

async function appendExecution(exec: TaskExecution): Promise<void> {
  await fs.mkdir(executionsDir(), { recursive: true });
  const file = executionFile(exec.taskId);
  const history = await readJson<TaskExecution[]>(file, []);
  history.push(exec);
  // Cap in-file history to a reasonable size; keep the most recent runs.
  const capped = history.slice(-500);
  await writeFileAtomic(file, JSON.stringify(capped, null, 2));
}

export async function listExecutions(taskId: string): Promise<TaskExecution[]> {
  return readJson<TaskExecution[]>(executionFile(taskId), []);
}
