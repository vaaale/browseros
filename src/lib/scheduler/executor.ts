import "server-only";
import { logger } from "@/lib/logging";
import { recordExecution } from "./storage";
import type { Task, TaskExecution } from "./types";

// Sub-agent modules are loaded lazily to break the module cycle between the
// scheduler's agent-tools (registered in SUBAGENT_TOOLS) and the sub-agent
// runner. Both modules resolve their top-level imports before either has
// finished evaluating; without the lazy load, `runSubAgent` would be undefined
// when the tools file first loads.
async function subagents() {
  const [{ getAgent }, { runSubAgent }] = await Promise.all([
    import("@/lib/agent/subagents/store"),
    import("@/lib/agent/subagents/runner"),
  ]);
  return { getAgent, runSubAgent };
}

const LOG = "scheduler.executor";

/**
 * Run a single task by dispatching its prompt to the configured sub-agent.
 * Never throws: caught errors are logged and recorded as an error execution so
 * the daemon loop can keep running.
 */
export async function executeTask(task: Task): Promise<TaskExecution> {
  const startedAt = Date.now();
  logger().info(LOG, `run task: ${task.name}`, { taskId: task.id, agentId: task.agentId });

  const { getAgent, runSubAgent } = await subagents();
  const agent = await getAgent(task.agentId);
  if (!agent) {
    const duration = Date.now() - startedAt;
    const error = `Agent "${task.agentId}" not found`;
    logger().error(LOG, error, { taskId: task.id });
    const updated = await recordExecution(task.id, {
      executedAt: new Date(startedAt).toISOString(),
      status: "error",
      duration,
      error,
    });
    return findLatestExec(updated?.id ?? task.id, error, duration, startedAt, "error");
  }

  try {
    const result = await runSubAgent(agent, task.prompt, { contentOnly: true });
    const duration = Date.now() - startedAt;
    if (result.error) {
      logger().error(LOG, `task failed: ${task.name}`, { taskId: task.id, error: result.error });
      await recordExecution(task.id, {
        executedAt: new Date(startedAt).toISOString(),
        status: "error",
        duration,
        error: result.error,
      });
      return findLatestExec(task.id, result.error, duration, startedAt, "error");
    }
    logger().info(LOG, `task ok: ${task.name}`, { taskId: task.id, duration, steps: result.steps });
    await recordExecution(task.id, {
      executedAt: new Date(startedAt).toISOString(),
      status: "success",
      duration,
      output: (result.output ?? "").slice(0, 4000),
    });
    return findLatestExec(task.id, undefined, duration, startedAt, "success", result.output);
  } catch (err) {
    const duration = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    logger().error(LOG, `task crashed: ${task.name}`, { taskId: task.id, error: message });
    await recordExecution(task.id, {
      executedAt: new Date(startedAt).toISOString(),
      status: "error",
      duration,
      error: message,
    });
    return findLatestExec(task.id, message, duration, startedAt, "error");
  }
}

// Small helper to return a synthetic TaskExecution shape to the caller without
// re-reading the executions file; the persisted copy is the source of truth.
function findLatestExec(
  taskId: string,
  error: string | undefined,
  duration: number,
  startedAt: number,
  status: TaskExecution["status"],
  output?: string,
): TaskExecution {
  return {
    id: "",
    taskId,
    executedAt: new Date(startedAt).toISOString(),
    status,
    duration,
    ...(output ? { output: output.slice(0, 4000) } : {}),
    ...(error ? { error } : {}),
  };
}
