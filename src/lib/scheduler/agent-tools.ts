import "server-only";
import type { LlmTool } from "@/lib/agent/llm";
import { getTask, createTask, updateTask, deleteTask, listTasks, pauseTask, resumeTask, listExecutions } from "./storage";
import { runTaskNow } from "./daemon";
import type { ScheduleConfig } from "./types";

// Sub-agent tools that expose the scheduler over the same tool-calling contract
// used by every other BOS sub-agent capability. Registered in
// src/lib/agent/subagents/tools.ts alongside SUBAGENT_TOOLS so agents can opt in.
export const SCHEDULER_TOOLS: Record<string, LlmTool> = {
  list_scheduled_tasks: {
    description: "List all scheduled tasks with their current status and next run time.",
    parameters: { type: "object", properties: {} },
    execute: async () => JSON.stringify(await listTasks(), null, 2),
  },
  get_scheduled_task: {
    description: "Get a scheduled task by id, including its recent execution history.",
    parameters: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
    execute: async (input) => {
      const id = String(input.taskId ?? "");
      const task = await getTask(id);
      if (!task) return `No task with id ${id}`;
      const history = await listExecutions(id);
      return JSON.stringify({ task, history: history.slice(-20) }, null, 2);
    },
  },
  create_scheduled_task: {
    description:
      "Create a new scheduled task. scheduleConfig is either { type: 'one-time', datetime: ISO } or " +
      "{ type: 'recurring', interval: number, unit: 'minute'|'hour'|'day'|'week', startTime?: ISO }.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        prompt: { type: "string", description: "The message to send to the agent when the task runs." },
        agentId: { type: "string", description: "Id of the sub-agent that should receive the prompt." },
        scheduleConfig: {
          type: "object",
          description: "One-time or recurring schedule definition.",
        },
        deleteAfterExecution: { type: "boolean" },
      },
      required: ["name", "prompt", "agentId", "scheduleConfig"],
    },
    execute: async (input) => {
      const cfg = input.scheduleConfig as ScheduleConfig;
      const task = await createTask({
        name: String(input.name ?? ""),
        prompt: String(input.prompt ?? ""),
        agentId: String(input.agentId ?? ""),
        scheduleConfig: cfg,
        deleteAfterExecution: !!input.deleteAfterExecution,
      });
      return JSON.stringify(task, null, 2);
    },
  },
  update_scheduled_task: {
    description: "Update a scheduled task's mutable fields (name, prompt, agentId, scheduleConfig, deleteAfterExecution).",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        name: { type: "string" },
        prompt: { type: "string" },
        agentId: { type: "string" },
        scheduleConfig: { type: "object" },
        deleteAfterExecution: { type: "boolean" },
      },
      required: ["taskId"],
    },
    execute: async (input) => {
      const id = String(input.taskId ?? "");
      const task = await updateTask(id, {
        ...(typeof input.name === "string" ? { name: input.name } : {}),
        ...(typeof input.prompt === "string" ? { prompt: input.prompt } : {}),
        ...(typeof input.agentId === "string" ? { agentId: input.agentId } : {}),
        ...(typeof input.deleteAfterExecution === "boolean"
          ? { deleteAfterExecution: input.deleteAfterExecution }
          : {}),
        ...(input.scheduleConfig ? { scheduleConfig: input.scheduleConfig as ScheduleConfig } : {}),
      });
      return task ? JSON.stringify(task, null, 2) : `No task with id ${id}`;
    },
  },
  update_task_schedule: {
    description: "Update just the schedule of a task, leaving other fields unchanged.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        scheduleConfig: { type: "object" },
      },
      required: ["taskId", "scheduleConfig"],
    },
    execute: async (input) => {
      const id = String(input.taskId ?? "");
      const task = await updateTask(id, { scheduleConfig: input.scheduleConfig as ScheduleConfig });
      return task ? JSON.stringify(task, null, 2) : `No task with id ${id}`;
    },
  },
  pause_scheduled_task: {
    description: "Pause a scheduled task. Its nextRunAt is cleared until resumed.",
    parameters: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
    execute: async (input) => {
      const id = String(input.taskId ?? "");
      const task = await pauseTask(id);
      return task ? JSON.stringify(task, null, 2) : `No task with id ${id}`;
    },
  },
  resume_scheduled_task: {
    description: "Resume a paused task and recalculate its next run time.",
    parameters: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
    execute: async (input) => {
      const id = String(input.taskId ?? "");
      const task = await resumeTask(id);
      return task ? JSON.stringify(task, null, 2) : `No task with id ${id}`;
    },
  },
  delete_scheduled_task: {
    description: "Permanently delete a scheduled task and its execution history.",
    parameters: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
    execute: async (input) => {
      const id = String(input.taskId ?? "");
      const ok = await deleteTask(id);
      return ok ? `Deleted ${id}` : `No task with id ${id}`;
    },
  },
  run_task_now: {
    description: "Run a scheduled task immediately, regardless of its schedule.",
    parameters: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
    execute: async (input) => {
      const id = String(input.taskId ?? "");
      const task = await getTask(id);
      if (!task) return `No task with id ${id}`;
      await runTaskNow(task);
      return `Ran ${task.name} (${id})`;
    },
  },
};
