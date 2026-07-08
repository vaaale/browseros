import "server-only";
import type { LlmTool } from "@/lib/agent/llm";
import {
  createJob,
  deleteJob,
  getJob,
  listJobs,
  listHistory,
  pauseJob,
  resumeJob,
  updateJob,
  runJobNow,
} from "./engine";
import { installBuiltInHandlers } from "./executor";
import type { JobHandler, ScheduleConfig } from "./types";

// Sub-agent tools that expose the Unified Job Engine over the same
// tool-calling contract used by every other BOS sub-agent capability. Names
// are kept in the "…scheduled_task" naming pattern so existing agents keep
// working, but the payload shape follows JobDefinition (handler + category).
//
// The `prompt` handler is installed lazily on first tool call so an agent
// that only lists tasks never pulls the sub-agent runner into memory.

function ensureHandlers(): void {
  installBuiltInHandlers();
}

export const SCHEDULER_TOOLS: Record<string, LlmTool> = {
  list_scheduled_tasks: {
    description:
      "List every scheduled job in BrowserOS (user, system, integration). Returns JobDefinition records with category, handler, schedule, status, next run.",
    parameters: { type: "object", properties: {} },
    execute: async () => JSON.stringify(await listJobs(), null, 2),
  },
  get_scheduled_task: {
    description: "Get a scheduled job by id, including its recent execution history.",
    parameters: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
    execute: async (input) => {
      const id = String(input.taskId ?? "");
      const job = await getJob(id);
      if (!job) return `No job with id ${id}`;
      const history = await listHistory(id, 20);
      return JSON.stringify({ job, history }, null, 2);
    },
  },
  create_scheduled_task: {
    description:
      "Create a new scheduled job. Only 'user' category is allowed here; system/integration jobs are seeded by their owning subsystem. " +
      "handler is { kind: 'prompt', prompt, agentId }. scheduleConfig is either { type: 'one-time', datetime } or { type: 'recurring', interval, unit, startTime? }.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        prompt: {
          type: "string",
          description: "The message to send to the agent when the job runs.",
        },
        agentId: {
          type: "string",
          description: "Id of the sub-agent that should receive the prompt.",
        },
        scheduleConfig: {
          type: "object",
          description: "One-time or recurring schedule definition.",
        },
        deleteAfterExecution: { type: "boolean" },
      },
      required: ["name", "prompt", "agentId", "scheduleConfig"],
    },
    execute: async (input) => {
      ensureHandlers();
      const handler: JobHandler = {
        kind: "prompt",
        prompt: String(input.prompt ?? ""),
        agentId: String(input.agentId ?? ""),
      };
      const job = await createJob({
        name: String(input.name ?? ""),
        category: "user",
        handler,
        scheduleConfig: input.scheduleConfig as ScheduleConfig,
        deleteAfterExecution: !!input.deleteAfterExecution,
      });
      return JSON.stringify(job, null, 2);
    },
  },
  update_scheduled_task: {
    description:
      "Update a scheduled job's mutable fields. Category-based ACL applies: system/integration jobs only allow schedule updates. " +
      "To change the prompt or agent, pass handler: { kind: 'prompt', prompt, agentId }.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        name: { type: "string" },
        handler: { type: "object" },
        scheduleConfig: { type: "object" },
        deleteAfterExecution: { type: "boolean" },
      },
      required: ["taskId"],
    },
    execute: async (input) => {
      const id = String(input.taskId ?? "");
      const updates: Parameters<typeof updateJob>[1] = {};
      if (typeof input.name === "string") updates.name = input.name;
      if (input.handler && typeof input.handler === "object") {
        updates.handler = input.handler as JobHandler;
      }
      if (input.scheduleConfig && typeof input.scheduleConfig === "object") {
        updates.scheduleConfig = input.scheduleConfig as ScheduleConfig;
      }
      if (typeof input.deleteAfterExecution === "boolean") {
        updates.deleteAfterExecution = input.deleteAfterExecution;
      }
      try {
        const job = await updateJob(id, updates);
        return job ? JSON.stringify(job, null, 2) : `No job with id ${id}`;
      } catch (err) {
        return `Update rejected: ${(err as Error).message}`;
      }
    },
  },
  update_task_schedule: {
    description: "Update just the schedule of a job, leaving other fields unchanged.",
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
      try {
        const job = await updateJob(id, { scheduleConfig: input.scheduleConfig as ScheduleConfig });
        return job ? JSON.stringify(job, null, 2) : `No job with id ${id}`;
      } catch (err) {
        return `Update rejected: ${(err as Error).message}`;
      }
    },
  },
  pause_scheduled_task: {
    description: "Pause a scheduled job. Its nextRunAt is cleared until resumed.",
    parameters: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
    execute: async (input) => {
      const id = String(input.taskId ?? "");
      const job = await pauseJob(id);
      return job ? JSON.stringify(job, null, 2) : `No job with id ${id}`;
    },
  },
  resume_scheduled_task: {
    description: "Resume a paused job and recalculate its next run time.",
    parameters: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
    execute: async (input) => {
      const id = String(input.taskId ?? "");
      const job = await resumeJob(id);
      return job ? JSON.stringify(job, null, 2) : `No job with id ${id}`;
    },
  },
  delete_scheduled_task: {
    description:
      "Permanently delete a scheduled job and its execution history. Rejected for system and integration jobs — those are managed by their owning subsystem.",
    parameters: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
    execute: async (input) => {
      const id = String(input.taskId ?? "");
      try {
        const ok = await deleteJob(id);
        return ok ? `Deleted ${id}` : `No job with id ${id}`;
      } catch (err) {
        return `Delete rejected: ${(err as Error).message}`;
      }
    },
  },
  run_task_now: {
    description: "Run a scheduled job immediately, regardless of its schedule.",
    parameters: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
    execute: async (input) => {
      ensureHandlers();
      const id = String(input.taskId ?? "");
      const job = await getJob(id);
      if (!job) return `No job with id ${id}`;
      await runJobNow(job);
      return `Ran ${job.name} (${id})`;
    },
  },
};
