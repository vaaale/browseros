import "server-only";
import { logger } from "@/lib/logging";
import { registerHandler, type HandlerRunResult } from "./engine";
import type { JobHandler } from "./types";

// The "prompt" handler dispatches a job's prompt to a sub-agent via the
// standard sub-agent runner. Kept in a dedicated module so the module cycle
// between the scheduler and the sub-agent runner stays broken by lazy loading.

const LOG = "scheduler.executor";

async function subagents() {
  const [{ getAgent }, { runSubAgent }] = await Promise.all([
    import("@/lib/agent/subagents/store"),
    import("@/lib/agent/subagents/runner"),
  ]);
  return { getAgent, runSubAgent };
}

async function runPromptHandler(handler: JobHandler): Promise<HandlerRunResult> {
  if (handler.kind !== "prompt") {
    return { status: "error", error: `prompt handler received wrong kind: ${handler.kind}` };
  }
  const { getAgent, runSubAgent } = await subagents();
  const agent = await getAgent(handler.agentId);
  if (!agent) {
    const error = `Agent "${handler.agentId}" not found`;
    logger().error(LOG, error);
    return { status: "error", error };
  }
  const result = await runSubAgent(agent, handler.prompt, { contentOnly: true });
  if (result.error) {
    return { status: "error", error: result.error };
  }
  return { status: "success", output: result.output ?? "" };
}

let installed = false;

/**
 * Install the built-in handlers on the engine. Safe to call multiple times —
 * idempotent because `registerHandler` overwrites on repeat.
 */
export function installBuiltInHandlers(): void {
  if (installed) return;
  installed = true;
  registerHandler("prompt", runPromptHandler);
}
