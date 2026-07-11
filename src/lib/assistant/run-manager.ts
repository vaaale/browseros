// RunManager — the single owner of assistant runs (framework-free; the routes
// wire it to HTTP). Invariants:
//   - at most ONE active run per conversation (double start throws → 409);
//   - the event log is append-only with monotonic seq; viewers replay ?since=
//     then tail live — N tabs are N viewers, never N executors;
//   - cancel is a server-side fact: abort() fires the loop's signal, and after
//     run_finished no further model turn can start, whatever clients do;
//   - frontend tool calls are pending promises here: first submitted result
//     wins, duplicates are ignored, run-abort and timeout settle them in-band.
//
// The instance lives on globalThis (same hot-reload-safe pattern as
// run-command.ts) so Next.js dev recompiles don't orphan active runs.

import type { RunEvent, RunEventInput, RunStatus, RunFinishReason } from "./run-events";
import type { AssistantTool, ToolDeclaration } from "./tools";

/** How long a finished run's event log stays attachable (late viewers, e2e). */
const RETENTION_MS = 5 * 60_000;
/** Safety cap on a single run's event log (text deltas dominate). */
const MAX_EVENTS = 50_000;

export type FrontendOutcome =
  | { kind: "result"; result: string }
  | { kind: "timeout" }
  | { kind: "cancelled" };

interface PendingFrontendCall {
  settle: (outcome: FrontendOutcome) => void;
}

export interface Run {
  id: string;
  conversationId: string;
  agentId: string;
  startedAt: number;
  status: RunStatus;
  error?: string;
  events: RunEvent[];
  seq: number;
  listeners: Set<(e: RunEvent) => void>;
  abort: AbortController;
  pendingFrontend: Map<string, PendingFrontendCall>;
  /** Settles when the loop has fully exited (set by the run starter). Lets an
   *  edit-resubmit cancel the active run and WAIT before truncating. */
  done?: Promise<void>;
  /** The SAME tools object the running loop reads each step (start-run.ts
   *  builds directly into this, never a separate copy) — so addSurfaceTools
   *  can extend an ACTIVE run's tool set mid-run, e.g. when the agent opens an
   *  app window and its Tier 2 surface tools become available, instead of
   *  only taking effect on the conversation's NEXT run. */
  tools: Record<string, AssistantTool>;
}

export class RunManager {
  private runs = new Map<string, Run>();
  private byConversation = new Map<string, string>();

  /** Create a run. Throws when the conversation already has an active run. */
  create(conversationId: string, agentId: string): Run {
    const activeId = this.byConversation.get(conversationId);
    if (activeId && this.runs.get(activeId)?.status === "running") {
      throw new ActiveRunError(activeId);
    }
    const run: Run = {
      id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      conversationId,
      agentId,
      startedAt: Date.now(),
      status: "running",
      events: [],
      seq: 0,
      listeners: new Set(),
      abort: new AbortController(),
      pendingFrontend: new Map(),
      tools: {},
    };
    this.runs.set(run.id, run);
    this.byConversation.set(conversationId, run.id);
    return run;
  }

  get(runId: string): Run | undefined {
    return this.runs.get(runId);
  }

  /** The conversation's active (still running) run, if any. */
  activeFor(conversationId: string): Run | undefined {
    const id = this.byConversation.get(conversationId);
    const run = id ? this.runs.get(id) : undefined;
    return run?.status === "running" ? run : undefined;
  }

  emit(run: Run, input: RunEventInput): RunEvent {
    const event: RunEvent = { ...input, seq: ++run.seq, ts: Date.now(), runId: run.id };
    run.events.push(event);
    if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
    for (const l of run.listeners) {
      try {
        l(event);
      } catch {
        /* a broken viewer never affects the run */
      }
    }
    return event;
  }

  /** Terminal transition. Emits run_finished, settles stragglers, schedules
   *  retention cleanup. Idempotent. */
  finish(run: Run, reason: RunFinishReason, error?: string): void {
    if (run.status !== "running") return;
    run.status = reason;
    run.error = error;
    for (const [, pending] of run.pendingFrontend) pending.settle({ kind: "cancelled" });
    run.pendingFrontend.clear();
    this.emit(run, { type: "run_finished", reason, error });
    if (this.byConversation.get(run.conversationId) === run.id) {
      this.byConversation.delete(run.conversationId);
    }
    const timer = setTimeout(() => {
      this.runs.delete(run.id);
      run.listeners.clear();
    }, RETENTION_MS);
    timer.unref?.();
  }

  /** Server-side stop. The loop observes the signal and drives the terminal
   *  run_finished{cancelled}; callers only fire the abort. */
  cancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.status !== "running") return false;
    run.abort.abort();
    return true;
  }

  /** Replay events after `since`, then tail live. Returns unsubscribe. */
  subscribe(run: Run, since: number, onEvent: (e: RunEvent) => void): () => void {
    for (const e of run.events) {
      if (e.seq > since) onEvent(e);
    }
    if (run.status !== "running") return () => undefined;
    run.listeners.add(onEvent);
    return () => run.listeners.delete(onEvent);
  }

  /** Loop-side: dispatch a frontend tool call and await its outcome. Settles on
   *  first submitted result, run abort, or timeout — never hangs, never throws. */
  awaitFrontendResult(run: Run, callId: string, timeoutMs: number): Promise<FrontendOutcome> {
    return new Promise<FrontendOutcome>((resolve) => {
      let done = false;
      const settle = (outcome: FrontendOutcome) => {
        if (done) return;
        done = true;
        run.pendingFrontend.delete(callId);
        clearTimeout(timer);
        run.abort.signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const onAbort = () => settle({ kind: "cancelled" });
      const timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
      timer.unref?.();
      run.abort.signal.addEventListener("abort", onAbort, { once: true });
      if (run.abort.signal.aborted) return onAbort();
      run.pendingFrontend.set(callId, { settle });
    });
  }

  /** Client-side claim: first result wins; duplicates/unknown calls → false. */
  submitToolResult(run: Run, callId: string, result: string): boolean {
    const pending = run.pendingFrontend.get(callId);
    if (!pending) return false;
    pending.settle({ kind: "result", result });
    return true;
  }

  /** Merge newly-available surface tool declarations into a LIVE run (additive
   *  only — mirrors the initial merge in start-run.ts). The agent loop reads
   *  `run.tools` fresh every step, so a tool added here is callable starting
   *  on the run's next step, without waiting for the conversation's next run.
   *  Existing entries are never overwritten. */
  addSurfaceTools(run: Run, declarations: ToolDeclaration[]): void {
    for (const d of declarations) {
      if (d?.name && !run.tools[d.name]) run.tools[d.name] = { ...d, execution: "frontend" };
    }
  }
}

export class ActiveRunError extends Error {
  constructor(public readonly activeRunId: string) {
    super(`Conversation already has an active run (${activeRunId}).`);
    this.name = "ActiveRunError";
  }
}

const g = globalThis as unknown as { __bosRunManager?: RunManager };

/** The process-wide manager (hot-reload-safe singleton). */
export function runManager(): RunManager {
  if (!g.__bosRunManager) g.__bosRunManager = new RunManager();
  return g.__bosRunManager;
}
