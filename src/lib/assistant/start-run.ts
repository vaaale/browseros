import "server-only";
import { runManager, ActiveRunError, type Run } from "./run-manager";
import { runAgentLoop } from "./agent-loop";
import { streamModelTurn } from "./model-turn";
import { conversationIO, loadConversationMessages } from "./conversation-store";
import { lastUserIndex } from "./messages";
import { assistantTools, gateFor } from "./registry";
import type { AssistantTool, ToolDeclaration } from "./tools";
import { composeInstructions } from "@/lib/agent/instructions";
import { getConversationActiveFeatureBranch } from "@/lib/agent/conversations-server";
import { getConfigValue } from "@/lib/config/registry";
import { logger } from "@/lib/logging";

// Glue between the HTTP routes and the framework-free run core: builds the
// loop's dependencies from real BOS services and owns the run lifecycle
// (create → loop → finish). The loop runs DETACHED from any request.

const DEFAULT_MAX_STEPS = 24;
const CANCEL_WAIT_MS = 10_000;

export interface StartRunOptions {
  conversationId: string;
  agentId: string;
  message: string;
  editOfMessageId?: string;
  /** Frontend tools contributed by the starting surface for THIS run. */
  surfaceTools?: ToolDeclaration[];
}

async function toolTimeoutMs(): Promise<number> {
  const sec = await getConfigValue("tools", "toolCallTimeoutSec").catch(() => undefined);
  return (typeof sec === "number" && sec > 0 ? sec : 600) * 1000;
}

export async function startAssistantRun(opts: StartRunOptions): Promise<Run> {
  const manager = runManager();

  // Edit-resubmit auto-cancels the conversation's active run ("stop, fix,
  // resend" is one action); a plain send while a run is active stays a 409.
  const active = manager.activeFor(opts.conversationId);
  if (active) {
    if (!opts.editOfMessageId) throw new ActiveRunError(active.id);
    manager.cancel(active.id);
    await Promise.race([active.done, new Promise((r) => setTimeout(r, CANCEL_WAIT_MS))]);
  }

  if (opts.editOfMessageId) {
    // Validate BEFORE creating the run so a bad edit is a clean 409, not a
    // run that instantly fails. The loop re-checks under its own load.
    const messages = await loadConversationMessages(opts.conversationId);
    const idx = lastUserIndex(messages);
    if (idx === -1 || messages[idx].id !== opts.editOfMessageId) {
      throw new Error(`Message ${opts.editOfMessageId} is not the last user message; cannot edit-resubmit.`);
    }
  }

  const run = manager.create(opts.conversationId, opts.agentId);
  manager.emit(run, {
    type: "run_started",
    conversationId: opts.conversationId,
    agentId: opts.agentId,
    ...(opts.editOfMessageId ? { truncatedFromMessageId: opts.editOfMessageId } : {}),
  });

  const tools: Record<string, AssistantTool> = { ...assistantTools() };
  for (const t of opts.surfaceTools ?? []) {
    if (t?.name && !tools[t.name]) tools[t.name] = { ...t, execution: "frontend" };
  }

  const [gate, timeoutMs] = await Promise.all([gateFor(opts.agentId), toolTimeoutMs()]);

  const composeSystem = async () => {
    let prompt = await composeInstructions(opts.agentId);
    const branch = await getConversationActiveFeatureBranch(opts.conversationId).catch(() => undefined);
    if (branch) {
      prompt += `\n\n## Active feature branch\nThis conversation already has an active feature branch \`${branch}\` for BrowserOS source changes. Do NOT call dev_branch_request — delegate the source change directly to the "developer" sub-agent.`;
    }
    return prompt;
  };

  logger().log({
    level: "info",
    component: "assistant.run",
    conversation: opts.conversationId,
    msg: "run started",
    data: { runId: run.id, agentId: opts.agentId, edit: !!opts.editOfMessageId },
  });

  run.done = (async () => {
    try {
      const result = await runAgentLoop(
        {
          conversationId: opts.conversationId,
          agentId: opts.agentId,
          signal: run.abort.signal,
          emit: (e) => manager.emit(run, e),
          streamTurn: streamModelTurn,
          composeSystem,
          tools,
          gate,
          io: conversationIO(opts.conversationId, opts.agentId),
          awaitFrontendResult: (callId, ms) => manager.awaitFrontendResult(run, callId, ms),
          maxSteps: DEFAULT_MAX_STEPS,
          toolTimeoutMs: timeoutMs,
        },
        { userMessage: { content: opts.message }, editOfMessageId: opts.editOfMessageId },
      );
      manager.finish(run, result.reason, result.error);
      logger().log({
        level: result.reason === "error" ? "error" : "info",
        component: "assistant.run",
        conversation: opts.conversationId,
        msg: `run finished: ${result.reason}`,
        data: { runId: run.id, error: result.error },
      });
    } catch (e) {
      // runAgentLoop settles internally; this is a genuine bug backstop.
      manager.finish(run, "error", (e as Error).message);
      logger().error("assistant.run", "run crashed", e);
    }
  })();

  return run;
}
