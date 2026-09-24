import "server-only";
import * as vfs from "@/os/vfs";
import { logger } from "@/lib/logging";
import { isValidFeatureBranch } from "@/lib/agent/feature-branch";
import {
  claimInFlightSlot,
  clearInFlightSlot,
  deleteCase,
  getCase,
  getDedupeEntry,
  getInFlightSlowPathCaseId,
  createCase,
  releaseInFlightSlot,
  updateCase,
  listCases,
  readIndex,
  updateRunStatus,
} from "./store";
import { abortHeadlessRun, hasRun } from "@/lib/agent/subagents/run-registry";
import { createRunObserver, inFlightRunFor, type RunEndVerdict } from "./runs";
import { readSelfHealConfig, triggerEnabled } from "./config";
import { computeFailureSignature, dedupeWindowSecFor } from "./signature";
import { isEnvironmentalError, isBosOwnedLogComponent } from "./allowlist";
import { capExhaustedForToday, recordCaseCost } from "./cost";
import { dequeueSlow, enqueueCost, enqueueSlow, sweepSuspendedTimeouts } from "./queue";
import { isSelfHealConversation, isSelfHealOriginPayload, markSelfHealConversation } from "./reentrancy";
import { ownedItemFor, ownershipFacts, runDiagnostician } from "./diagnostician";
import { buildAutonomousBrief, buildRestartBrief, buildResumeBrief } from "./brief";
import { emitSelfHeal, casePayload, summaryFor, SELF_HEAL_LOG } from "./events";
import {
  SELF_HEAL_EVENTS,
  humanCaseId,
  isTerminalStatus,
  selfHealBranchFor,
  type CaseStatus,
  type HealingCase,
  type ProposedEdit,
  type TriggerContext,
} from "./types";

// The fast spine's ONE deterministic front door (031-self-healing, design
// ADR-1).
//
// Phase A (synchronous, must settle fast — a 034 core executor has an ack
// window): guards → dedupe → cost cap → create the case → emit `case_created` →
// launch the Diagnostician FIRE-AND-FORGET → return. Nothing here waits on an
// LLM.
//
// Phase B (asynchronous, on the Diagnostician's completion): read the report's
// verdict → route by scope class → for class e / d-bis, escalate to the
// autonomous Build Studio pipeline behind a single mutual-exclusion slot.
//
// Every Phase-B transition is an idempotent read-modify-write on the case store
// keyed by case id, so the event kernel's at-least-once redelivery and the
// boot-time reconcile can never double-act.

const BUILD_STUDIO_FALLBACK_AGENT = "build-studio";

/** Runtime `import()` for the agent layer — a static import would cycle through
 *  `assistantTools()`, which composes the self-heal tools that import this
 *  module. Same pattern as src/lib/scheduler/executor.ts. */
async function agentLayer() {
  const [{ getAgent }, { runSubAgent }, conversationStore, { readNamespace }] = await Promise.all([
    import("@/lib/agent/subagents/store"),
    import("@/lib/agent/subagents/runner"),
    import("@/lib/assistant/conversation-store"),
    import("@/lib/config/store"),
  ]);
  return { getAgent, runSubAgent, conversationStore, readNamespace };
}

// ── The two agent-run seams ────────────────────────────────────────────────
//
// Everything else in this module is deterministic; these two calls are the only
// places it reaches an LLM. Isolating them behind an overridable object is what
// makes the decision tree — the guards, the dedupe, the cap, the routing, the
// single slot, the suspend/resume handoff — testable end to end without a model
// or a provider key. Same `_…ForTests` convention as
// `_setBackoffScheduleForTests` in src/lib/events/dispatch.ts.

export interface PipelineRunInput {
  caseId: string;
  agentId: string;
  brief: string;
  conversationId: string;
  featureBranch?: string;
  /** The run observer's event sink (scope-add, ADR-12) — this is the seam that
   *  makes the pipeline run observable: the case learns its runId from the
   *  leading `run_started`, and every tool call feeds the stuck detector. */
  onEvent?: (event: import("@/lib/agent/subagents/types").SubAgentEvent) => void;
}

export interface PipelineRunOutput {
  output: string;
  error?: string;
  usage?: import("@/lib/agent/subagents/types").AgentRunUsage;
  /** Why the run ended (M1). Threaded through so the run-end handler can tell
   *  a step-budget exhaustion (FR-033(b) → `stopped`) from a clean completion
   *  with no fix (→ `failed`) — reading `error` alone cannot. */
  endedReason?: import("@/lib/agent/subagents/types").AgentRunEndedReason;
  aborted?: boolean;
  runId?: string;
}

export interface SpineAgentHooks {
  /** Run the Diagnostician for a case (writes the report, stamps the verdict). */
  diagnose: (caseId: string) => Promise<{ ok: boolean; error?: string }>;
  /** Is the agent that drives the slow path installed? Checked BEFORE any
   *  conversation is seeded, so a broken setup leaves no debris. */
  agentAvailable: (agentId: string) => Promise<boolean>;
  /** Run the autonomous Build Studio pipeline (or a resume of it). */
  runPipeline: (input: PipelineRunInput) => Promise<PipelineRunOutput>;
}

const DEFAULT_HOOKS: SpineAgentHooks = {
  diagnose: (caseId) => runDiagnostician(caseId),
  agentAvailable: async (agentId) => {
    const { getAgent } = await agentLayer();
    return !!(await getAgent(agentId));
  },
  runPipeline: async ({ agentId, brief, conversationId, featureBranch, onEvent }) => {
    const { getAgent, runSubAgent } = await agentLayer();
    const agent = await getAgent(agentId);
    if (!agent) return { output: "", error: `the agent "${agentId}" is not installed` };
    const result = await runSubAgent(agent, brief, {
      conversationId,
      contentOnly: false,
      ...(featureBranch ? { featureBranch } : {}),
      ...(onEvent ? { onEvent } : {}),
    });
    return {
      output: result.output,
      error: result.error,
      usage: result.usage,
      endedReason: result.endedReason,
      aborted: result.aborted,
      runId: result.runId,
    };
  },
};

let hooks: SpineAgentHooks = DEFAULT_HOOKS;

/** Tests only: override one or both agent-run seams. `null` restores the real
 *  implementations. */
export function _setSpineAgentHooksForTests(overrides: Partial<SpineAgentHooks> | null): void {
  hooks = overrides ? { ...DEFAULT_HOOKS, ...overrides } : DEFAULT_HOOKS;
}

// ── The Supervisor/git fact seam (FR-038) ───────────────────────────────────
//
// Settling a preview-ready case needs three external facts: which branches the
// Supervisor still knows, a branch's head SHA, and whether a SHA is an ancestor
// of base. Same overridable-seam discipline as the agent hooks above, so the
// settle/reconcile decision tree is testable without a Supervisor or git state.

export interface BranchFacts {
  /** Every branch the Supervisor knows, or undefined when not running under it
   *  (in which case "the branch is gone" is unknowable and the sweep skips). */
  listBranches: () => Promise<string[] | undefined>;
  /** Head SHA of a local branch; undefined when the ref no longer exists. */
  branchHeadSha: (branch: string) => Promise<string | undefined>;
  /** Is `sha` an ancestor of the base branch — i.e. was it merged? */
  isAncestorOfBase: (sha: string) => Promise<boolean>;
}

const DEFAULT_BRANCH_FACTS: BranchFacts = {
  listBranches: async () => {
    const { supervisorEnabled, supervisorBranches } = await import("@/lib/devharness/supervisor");
    if (!supervisorEnabled()) return undefined;
    const res = await supervisorBranches();
    const branches = res?.branches;
    if (!Array.isArray(branches)) return undefined;
    return branches.filter((b): b is string => typeof b === "string");
  },
  branchHeadSha: async (branch) => {
    const { branchHeadSha } = await import("@/lib/system/git");
    return branchHeadSha(branch);
  },
  isAncestorOfBase: async (sha) => {
    const [{ supervisorBranches }, { isAncestorOf }] = await Promise.all([
      import("@/lib/devharness/supervisor"),
      import("@/lib/system/git"),
    ]);
    const res = await supervisorBranches().catch(() => null);
    const base = typeof res?.base === "string" && res.base ? res.base : "main";
    return isAncestorOf(sha, base);
  },
};

let branchFacts: BranchFacts = DEFAULT_BRANCH_FACTS;

/** Tests only: override one or more branch facts. `null` restores the real
 *  implementations. */
export function _setBranchFactsForTests(overrides: Partial<BranchFacts> | null): void {
  branchFacts = overrides ? { ...DEFAULT_BRANCH_FACTS, ...overrides } : DEFAULT_BRANCH_FACTS;
}

// ── Phase A: intake ─────────────────────────────────────────────────────────

export type IntakeOutcome =
  | { action: "disabled"; reason: string }
  | { action: "trigger-disabled"; reason: string }
  | { action: "reentrancy-skipped"; reason: string }
  | { action: "environmental"; reason: string }
  | { action: "not-bos-owned"; reason: string }
  | { action: "duplicate"; caseId: string; originalCaseId: string }
  | { action: "queued-cost"; caseId: string }
  | { action: "created"; caseId: string };

export interface IntakeOptions {
  /** The raw event payload, when the trigger arrived as a 034 event. Checked
   *  against the re-entrancy filter (design ADR-4 guard b). */
  eventPayload?: unknown;
  /** Await the Diagnostician instead of launching it fire-and-forget. Tests and
   *  the scheduled pass use this; the event handler never does. */
  awaitDiagnosis?: boolean;
}

/**
 * The front door. Returns what it decided, always — a suppressed trigger is a
 * reported outcome, never a silent no-op.
 */
export async function selfHealIntake(ctx: TriggerContext, opts: IntakeOptions = {}): Promise<IntakeOutcome> {
  const cfg = await readSelfHealConfig();

  // FR-006 / SC-006: the kill switch short-circuits before anything is written
  // and before any token is spent.
  if (!cfg.enabled) return { action: "disabled", reason: "selfHeal.enabled is false" };
  if (!triggerEnabled(cfg, ctx.trigger)) {
    return { action: "trigger-disabled", reason: `the "${ctx.trigger}" trigger is disabled` };
  }

  // FR-025 guard (b): an event produced BY a self-heal run never re-enters.
  // Deterministic and hook-independent, so recursion stays bounded regardless
  // of which run path emitted it.
  if (isSelfHealOriginPayload(opts.eventPayload)) {
    return { action: "reentrancy-skipped", reason: "the event payload carries a selfHeal role marker" };
  }
  // FR-025 guard (a): a run driven from a spine-seeded conversation.
  if (ctx.conversationId && (await isSelfHealConversation(ctx.conversationId))) {
    return { action: "reentrancy-skipped", reason: `conversation ${ctx.conversationId} is self-heal-origin` };
  }

  // FR-002 / SC-003: unconditionally external failures never reach the
  // Diagnostician. `permission_denied` is deliberately NOT in that set (C2).
  if (isEnvironmentalError(ctx)) {
    return { action: "environmental", reason: "the error matches the environmental allowlist" };
  }
  // FR-005: only error-level logs from BOS-owned component namespaces trigger.
  if (ctx.trigger === "log-events" && !isBosOwnedLogComponent(ctx.component)) {
    return { action: "not-bos-owned", reason: `component "${ctx.component ?? ""}" is not BOS-owned` };
  }

  const signature = computeFailureSignature(ctx);

  // FR-019: dedupe BEFORE diagnosis, deterministically — a duplicate must never
  // cost Diagnostician tokens.
  const existing = await getDedupeEntry(signature.dedupeKey);
  if (existing) {
    const windowMs = dedupeWindowSecFor(ctx.trigger, cfg) * 1000;
    if (windowMs > 0 && Date.now() - existing.at <= windowMs) {
      await emitSelfHeal(SELF_HEAL_EVENTS.dedupeSuppressed, {
        originalCaseId: existing.caseId,
        dedupeKey: signature.dedupeKey,
        trigger: ctx.trigger,
        title: signature.label,
        summary: `Self-heal trigger suppressed as a duplicate of ${humanCaseId(existing.caseId)} — ${signature.label}`,
        selfHeal: { role: "lifecycle", caseId: existing.caseId },
      });
      logger().info(SELF_HEAL_LOG, "trigger suppressed as duplicate", {
        dedupeKey: signature.dedupeKey,
        originalCaseId: existing.caseId,
      });
      return { action: "duplicate", caseId: existing.caseId, originalCaseId: existing.caseId };
    }
  }

  // FR-020: over the cap, a trigger is QUEUED, never dropped.
  const capped = await capExhaustedForToday();
  const record = await createCase({
    trigger: ctx.trigger,
    title: signature.label,
    signature,
    context: ctx,
    status: capped ? "queued-cost" : "new",
    note: capped
      ? `daily cost cap reached — queued for the next UTC day (${ctx.trigger} trigger)`
      : `case created from the ${ctx.trigger} trigger`,
  });

  await emitSelfHeal(SELF_HEAL_EVENTS.caseCreated, {
    ...casePayload(record),
    summary: summaryFor(record, capped ? "created (queued: cost cap)" : "created"),
  });

  if (capped) {
    await enqueueCost(record.id);
    return { action: "queued-cost", caseId: record.id };
  }

  // ADR-1/R4: the Diagnostician is a multi-minute LLM step and MUST NOT be
  // awaited inside a 034 core executor, whose ack window would expire and mark
  // the handler failed. Phase B is a separate re-entry, not a continuation.
  const diagnose = async () => {
    const outcome = await hooks.diagnose(record.id);
    if (outcome.ok) await resolveDiagnosedCase(record.id);
  };
  if (opts.awaitDiagnosis) await diagnose();
  else void diagnose().catch((err) => logger().error(SELF_HEAL_LOG, "diagnosis failed", undefined, { caseId: record.id, error: (err as Error).message }));

  return { action: "created", caseId: record.id };
}

// ── Phase B: scope-class routing ────────────────────────────────────────────

export type ResolveOutcome =
  | { action: "closed"; caseId: string; status: HealingCase["status"] }
  | { action: "awaiting-consent"; caseId: string }
  | { action: "notified"; caseId: string; appId?: string }
  | { action: "escalated"; caseId: string }
  | { action: "queued-slow"; caseId: string; position: number }
  | { action: "skipped"; caseId: string; reason: string };

/**
 * Route a diagnosed case to its fix surface (FR-009..FR-014).
 *
 * The Diagnostician's report is the single source of truth for the class — the
 * pipeline never re-classifies. The ONE thing the spine overrides is the
 * d/d-bis ownership call, because that predicate is a server-side fact the
 * agent cannot observe (design §5: `app_list` does not expose provenance).
 */
export async function resolveDiagnosedCase(caseId: string): Promise<ResolveOutcome> {
  const record = await getCase(caseId);
  if (!record) return { action: "skipped", caseId, reason: "no such case" };
  if (isTerminalStatus(record.status)) {
    return { action: "skipped", caseId, reason: `already ${record.status}` };
  }
  if (!record.scopeClass) return { action: "skipped", caseId, reason: "not diagnosed yet" };

  switch (record.scopeClass) {
    case "a":
      return closeEnvOnly(record);
    case "b":
    case "c":
      return awaitConsent(record);
    case "d":
    case "d-bis":
      return resolveAppCase(record);
    case "e":
      return escalateCase(record.id);
  }
}

/** FR-009: environmental — close with no durable change, keep the suggestion. */
async function closeEnvOnly(record: HealingCase): Promise<ResolveOutcome> {
  const updated = await updateCase(record.id, {
    status: "env-only",
    note: "environmental/transient — closed with no durable change",
  });
  if (updated) {
    await emitSelfHeal(SELF_HEAL_EVENTS.caseClosed, {
      ...casePayload(updated),
      resolution: "env-only",
      summary: summaryFor(updated, "closed as environmental (no change made)"),
    });
  }
  return { action: "closed", caseId: record.id, status: "env-only" };
}

/** FR-010/FR-011: a specific skill or workflow edit, consent-gated. */
async function awaitConsent(record: HealingCase): Promise<ResolveOutcome> {
  const updated = await updateCase(record.id, {
    status: "awaiting-consent",
    note: record.proposedEdit
      ? `proposed ${record.proposedEdit.artifactType} edit to ${record.proposedEdit.target} — awaiting your approval`
      : `class ${record.scopeClass} — awaiting your approval (no concrete edit was proposed; review the report)`,
  });
  if (updated) {
    await emitSelfHeal(SELF_HEAL_EVENTS.caseCreated, {
      ...casePayload(updated),
      needsConsent: true,
      summary: summaryFor(updated, `needs your approval (class ${record.scopeClass})`),
    });
  }
  return { action: "awaiting-consent", caseId: record.id };
}

/**
 * FR-012/FR-013: the ownership boundary.
 *
 * The Diagnostician's d/d-bis call is ADVISORY. Confirm it here against
 * `listInstalledItems()`'s derived provenance and correct it either way — a
 * misread in this direction is either a refused fix the user could have had, or
 * an attempted modification of an app the user does not own.
 */
async function resolveAppCase(record: HealingCase): Promise<ResolveOutcome> {
  const facts = await ownershipFacts();
  const owned = ownedItemFor(facts, record.appId, record.proposedSurface, record.context.appId, record.title);
  if (owned) {
    if (record.scopeClass !== "d-bis" || record.appId !== owned.id) {
      await updateCase(record.id, {
        scopeClass: "d-bis",
        ownership: "user-app",
        appId: owned.id,
        note: `ownership confirmed server-side: "${owned.id}" resolves into data/user-apps/items/ — reclassified d-bis (fixable)`,
      });
    }
    return escalateCase(record.id);
  }

  // Not owned ⇒ notify only, never modify (FR-012).
  const updated = await updateCase(record.id, {
    scopeClass: "d",
    ownership: "marketplace",
    status: "notified",
    note: "the app is not present in data/user-apps/items/ — notification only, no modification attempted",
  });
  if (updated) {
    await emitSelfHeal(SELF_HEAL_EVENTS.appNotify, {
      ...casePayload(updated),
      appId: updated.appId ?? updated.context.appId,
      summary: summaryFor(updated, "suspected bug in an app you do not maintain — notification only"),
    });
  }
  return { action: "notified", caseId: record.id, appId: updated?.appId };
}

// ── The slow path (FR-015/015b/015c) ────────────────────────────────────────

export function pipelineConversationId(caseId: string): string {
  return `c-self-heal-fix-${caseId}`;
}

async function buildStudioAgentId(): Promise<string> {
  try {
    const { readNamespace } = await agentLayer();
    const ns = await readNamespace("build-studio");
    const id = typeof ns.agent === "string" ? ns.agent.trim() : "";
    return id || BUILD_STUDIO_FALLBACK_AGENT;
  } catch {
    return BUILD_STUDIO_FALLBACK_AGENT;
  }
}

/**
 * Escalate a class-e / class-d-bis case to the autonomous Build Studio pipeline.
 *
 * FR-015c: exactly ONE case may be in `bs-pipeline` at a time. A second
 * escalation goes to the FIFO behind the slot and is picked up by
 * `releaseSlotAndDequeue` when the slot clears.
 */
export async function escalateCase(caseId: string): Promise<ResolveOutcome> {
  const record = await getCase(caseId);
  if (!record) return { action: "skipped", caseId, reason: "no such case" };
  if (record.status === "bs-pipeline" || record.status === "suspended") {
    return { action: "skipped", caseId, reason: `already ${record.status}` };
  }
  if (isTerminalStatus(record.status)) return { action: "skipped", caseId, reason: `already ${record.status}` };

  const claimed = await claimInFlightSlot(caseId);
  if (!claimed) {
    const position = await enqueueSlow(caseId);
    await updateCase(caseId, {
      status: "queued-slow",
      note: `another fix is in the pipeline — queued at position ${position}`,
    });
    return { action: "queued-slow", caseId, position };
  }

  const cfg = await readSelfHealConfig();
  if (!cfg.autonomousImplement) {
    // Autonomy switched off: the case is diagnosed and escalation-worthy, but
    // the user has said the pipeline must not run itself. Park it for consent
    // rather than pretending it was handled.
    await clearInFlightSlot(caseId);
    await updateCase(caseId, {
      status: "awaiting-consent",
      note: "selfHeal.autonomousImplement is off — the fix is ready to start but needs your go-ahead",
    });
    return { action: "awaiting-consent", caseId };
  }

  const reportBody = record.reportPath ? await vfs.readText(record.reportPath).catch(() => "") : "";
  const isCore = record.scopeClass === "e";
  const featureBranch = isCore ? selfHealBranchFor(record.id) : undefined;
  if (featureBranch && !isValidFeatureBranch(featureBranch)) {
    const error = `derived branch "${featureBranch}" is not a valid feature branch`;
    await clearInFlightSlot(caseId);
    await updateCase(caseId, { status: "failed", error, note: error });
    return { action: "skipped", caseId, reason: error };
  }

  const brief = buildAutonomousBrief({ record, cfg, reportBody, featureBranch });
  const conversationId = pipelineConversationId(record.id);
  const agentId = await buildStudioAgentId();
  const { conversationStore } = await agentLayer();
  if (!(await hooks.agentAvailable(agentId))) {
    const error = `the Build Studio agent "${agentId}" is not installed`;
    await clearInFlightSlot(caseId);
    await updateCase(caseId, { status: "failed", error, note: error });
    return { action: "skipped", caseId, reason: error };
  }

  // FR-015b / ADR-3 — the entirety of "branch pre-creation":
  //  1. seed the conversation (this CREATES the file; the branch patch below is
  //     a no-op on a missing conversation),
  //  2. set `activeFeatureBranch` BEFORE the agent's first token.
  // The git ref is NOT created here: `supervisorBegin` provisions it lazily at
  // the first `dev_delegate`. Pre-conditioning the field is all FR-015b needs —
  // it is what stops the agent from calling `dev_branch_request`, a frontend
  // elicitation that would block an autonomous run indefinitely.
  await conversationStore.saveConversationMessages(conversationId, agentId, [
    { id: `m-${record.id}-brief`, role: "user", content: brief },
  ]);
  await markSelfHealConversation(conversationId, { role: "pipeline", caseId: record.id });
  if (featureBranch) {
    await conversationStore.setConversationActiveFeatureBranch(conversationId, featureBranch);
  }

  const updated = await updateCase(caseId, {
    status: "bs-pipeline",
    conversationId,
    ...(featureBranch ? { activeFeatureBranch: featureBranch } : {}),
    note: featureBranch
      ? `escalated to the autonomous Build Studio pipeline on ${featureBranch}`
      : "escalated to the autonomous Build Studio pipeline (app_build delivery)",
  });
  if (updated) {
    await emitSelfHeal(SELF_HEAL_EVENTS.caseEscalated, {
      ...casePayload(updated),
      conversationId,
      ...(featureBranch ? { branch: featureBranch } : {}),
      summary: summaryFor(updated, featureBranch ? `escalated — building on ${featureBranch}` : "escalated — rebuilding the app"),
    });
  }

  // Fire-and-forget for the same reason the Diagnostician is: this run lasts
  // hours. Its completion is reported by the agent calling
  // `self_heal_complete_fix`; a run that dies without doing so is recovered by
  // `reconcileInFlightCases` (design ADR-8's fallback).
  await launchPipeline({ caseId, agentId, brief, conversationId, featureBranch });

  return { action: "escalated", caseId };
}

/**
 * Launch the pipeline run fire-and-forget, WITH the run observer attached
 * (scope-add, ADR-12/ADR-13).
 *
 * Shared by escalation, resume and Start so all three produce an observable,
 * stoppable run — a run only reachable from one of the three would be a Stop
 * button that works sometimes.
 */
async function launchPipeline(input: {
  caseId: string;
  agentId: string;
  brief: string;
  conversationId: string;
  featureBranch?: string;
  costRole?: "pipeline" | "resume";
}): Promise<void> {
  const { caseId, agentId, brief, conversationId, featureBranch } = input;
  const observer = await createRunObserver({ caseId, role: "pipeline", agentId });
  void hooks
    .runPipeline({
      caseId,
      agentId,
      brief,
      conversationId,
      ...(featureBranch ? { featureBranch } : {}),
      onEvent: observer.onEvent,
    })
    .then(async (result) => {
      await recordCaseCost(caseId, input.costRole ?? "pipeline", result.usage, [brief, result.output]);
      const verdict = await observer.finish({
        ...(result.endedReason ? { endedReason: result.endedReason } : {}),
        ...(result.aborted !== undefined ? { aborted: result.aborted } : {}),
        ...(result.error ? { error: result.error } : {}),
      });
      await onPipelineRunEnded(caseId, result.error, verdict);
    })
    .catch(async (err) => {
      const message = (err as Error).message;
      const verdict = await observer.finish({ endedReason: "error", error: message });
      await onPipelineRunEnded(caseId, message, verdict);
    });
}

/**
 * The pipeline run returned. If the case already reached a terminal state (the
 * agent called `self_heal_complete_fix`) or suspended, there is nothing to do.
 * Otherwise the run ended without delivering — record it as `failed` (FR:
 * "preview build failure ⇒ failed, no auto-retry") and free the slot.
 */
async function onPipelineRunEnded(caseId: string, error?: string, verdict?: RunEndVerdict): Promise<void> {
  const record = await getCase(caseId);
  if (!record) return;
  if (isTerminalStatus(record.status) || record.status === "suspended") return;
  // The user's Stop already owns this case's state (and already freed the
  // slot); the run settling afterwards must not overwrite `stopped` with
  // `failed`.
  if (record.status === "stopped" || verdict?.aborted) return;
  // FR-033(b), M1: the run exhausted its step budget. Before the scope-add this
  // was indistinguishable from a clean run that simply never reported a fix, so
  // it was recorded as `failed` — terminal, unrecoverable, and silent about
  // WHY. It is `stopped` instead: non-terminal, with the transcript to read and
  // a Start to relaunch from the last committed artifact.
  if (verdict?.stopCase) {
    const note = "the pipeline run used its whole step budget without reporting a fix — stopped, restartable with Start";
    const updated = await updateCase(caseId, { status: "stopped", stoppedFrom: record.status, note });
    logger().warn(SELF_HEAL_LOG, "pipeline run hit max steps", { caseId });
    await releaseSlotAndDequeue(caseId);
    if (updated) {
      await emitSelfHeal(SELF_HEAL_EVENTS.runStuck, {
        ...casePayload(updated),
        ...(verdict.runId ? { runId: verdict.runId } : {}),
        summary: summaryFor(updated, "stopped — the run used its whole step budget"),
      });
    }
    return;
  }
  const reason = error
    ? `the pipeline run ended with an error: ${error}`
    : "the pipeline run ended without reporting a completed fix";
  await updateCase(caseId, { status: "failed", error: reason, note: reason });
  logger().warn(SELF_HEAL_LOG, "pipeline run ended without a fix", { caseId, error: error ?? "" });
  await releaseSlotAndDequeue(caseId);
}

/**
 * Release the single slot and start the next queued escalation.
 *
 * Dequeuing is RE-ENTRY, not a new trigger: the case was already admitted, so
 * it is deliberately NOT re-checked against dedupe or the cost cap (ADR-9).
 */
export async function releaseSlotAndDequeue(caseId?: string): Promise<string | undefined> {
  await clearInFlightSlot(caseId);
  return dequeueNextEscalation();
}

// ── Suspend / resume (FR-016) ───────────────────────────────────────────────

export async function suspendCase(caseId: string, question: string): Promise<HealingCase | undefined> {
  const record = await getCase(caseId);
  if (!record) return undefined;
  const updated = await updateCase(caseId, {
    status: "suspended",
    pendingQuestion: question,
    suspendedAt: Date.now(),
    note: "suspended — waiting on a decision only the user can make",
  });
  if (updated) {
    await emitSelfHeal(SELF_HEAL_EVENTS.decisionNeeded, {
      ...casePayload(updated),
      question,
      summary: summaryFor(updated, "needs a decision from you"),
    });
  }
  // The slot is deliberately HELD while suspended: an unanswered question still
  // blocks the pipeline, and the suspended-timeout sweep is what releases it.
  return updated;
}

/**
 * The user answered. Re-enter the SAME conversation with the answer appended
 * (clarification C5's terminate-and-retrigger): the agent recovers every
 * confirmed decision from the artifacts on disk (commit-before-advance) and
 * continues.
 */
export async function resumeCase(caseId: string, answer: string): Promise<HealingCase | undefined> {
  const record = await getCase(caseId);
  if (!record) return undefined;
  if (record.status !== "suspended") {
    logger().info(SELF_HEAL_LOG, "resume ignored — case is not suspended", { caseId, status: record.status });
    return record;
  }
  const conversationId = record.conversationId ?? pipelineConversationId(caseId);

  await emitSelfHeal(SELF_HEAL_EVENTS.decisionResolved, {
    ...casePayload(record),
    question: record.pendingQuestion,
    answer,
    summary: summaryFor(record, "decision answered — resuming"),
  });

  const updated = await updateCase(caseId, {
    status: "bs-pipeline",
    decisionAnswer: answer,
    pendingQuestion: undefined,
    note: "decision answered — pipeline resumed",
  });
  await claimInFlightSlot(caseId);

  const agentId = await buildStudioAgentId();
  const resumeBrief = buildResumeBrief(record, answer);
  await launchPipeline({
    caseId,
    agentId,
    brief: resumeBrief,
    conversationId,
    ...(record.activeFeatureBranch ? { featureBranch: record.activeFeatureBranch } : {}),
    costRole: "resume",
  });
  return updated;
}

// ── Stop / Start a live run (FR-034, scope-add ADR-13) ──────────────────────

export interface RunControlOutcome {
  ok: boolean;
  /** Did this call actually change anything? A Stop with no live run and a
   *  Start on a case that is not stopped are both no-ops that report the
   *  current truth rather than erroring (R14). */
  changed: boolean;
  case?: HealingCase;
  reason?: string;
}

/** The two in-flight states that HAVE a live run to stop. `suspended` does not:
 *  a suspended run has already ended (terminate-and-retrigger), so there is
 *  nothing to kill — and neither does a queued case. */
const STOPPABLE: CaseStatus[] = ["diagnosing", "bs-pipeline"];

/**
 * Stop the case's in-flight run (FR-034).
 *
 * Kills the run — cascading to any nested Developer CLI child (ADR-11), so Stop
 * genuinely means stopped — then records `stopped` with the state it came from,
 * marks the run entry `aborted`, and FREES the slow-path slot. Freeing it is
 * deliberate: a stopped run consumes nothing, and holding the single slot for
 * as long as the user leaves it stopped would block every other fix (ADR-13).
 *
 * Recoverable, not destructive: `stopped` is not terminal and `startRun` brings
 * it back. That is also why the UI renders Stop amber rather than red.
 */
export async function stopRun(caseId: string): Promise<RunControlOutcome> {
  const record = await getCase(caseId);
  if (!record) return { ok: false, changed: false, reason: `no case "${caseId}"` };
  if (!STOPPABLE.includes(record.status)) {
    return {
      ok: true,
      changed: false,
      case: record,
      reason: `case ${humanCaseId(caseId)} is "${record.status}" — no run is in flight`,
    };
  }

  const run = await inFlightRunFor(caseId);
  // The state is written BEFORE the kill, deliberately. Aborting a run makes
  // its own promise settle immediately, and that run-end handler reads the
  // case — if it got there first it would record `failed` over the user's
  // Stop. Recording the user's decision first makes the ordering irrelevant.
  if (run) await updateRunStatus(caseId, run.runId, "aborted");
  // Whether there is anything to kill is knowable BEFORE killing it, so the
  // timeline note can be honest about which of the two happened: a live run
  // terminated, or a case whose run was already gone (a restart, or the run
  // finishing between the click and this handler).
  const live = run ? hasRun(run.runId) : false;
  const note = live
    ? `stopped by you — the ${run!.role} run was killed`
    : "stopped by you — there was no live run left to kill";
  const updated = await updateCase(caseId, { status: "stopped", stoppedFrom: record.status, note });
  // `false` means the run had already finished (or lives in another process):
  // the case still moves to `stopped`, because the user's intent stands and the
  // state must be restartable — the outcome just reports the truth about
  // whether anything was actually killed.
  const killed = run ? abortHeadlessRun(run.runId) : false;
  // Non-terminal, so `updateCase` does not release the slot for us.
  await releaseInFlightSlot(caseId);
  const next = await dequeueNextEscalation();
  logger().info(SELF_HEAL_LOG, "run stopped", { caseId, runId: run?.runId ?? "", killed: String(killed), next: next ?? "" });

  if (updated) {
    await emitSelfHeal(SELF_HEAL_EVENTS.runAborted, {
      ...casePayload(updated),
      ...(run ? { runId: run.runId, role: run.role } : {}),
      killed,
      summary: summaryFor(updated, "stopped — the run was terminated"),
    });
  }
  return { ok: true, changed: true, ...(updated ? { case: updated } : {}) };
}

/**
 * Start a stopped case again (FR-034).
 *
 * Relaunches the role it was stopped from as a FRESH run — never a resume of
 * the killed one. Nothing confirmed before the Stop is lost: the pipeline
 * commits before it advances (FR-015), so the artifacts on disk ARE the resume
 * point, which is the same recovery the cold-restart path relies on. The new
 * run gets a new runId and a new `runs[]` entry; the aborted one stays in the
 * list to read.
 *
 * Start re-enters mutual exclusion like any escalation — if another case holds
 * the slot, this one queues instead of bypassing it.
 */
export async function startRun(caseId: string): Promise<RunControlOutcome> {
  const record = await getCase(caseId);
  if (!record) return { ok: false, changed: false, reason: `no case "${caseId}"` };
  if (record.status !== "stopped" && record.status !== "failed") {
    return { ok: true, changed: false, case: record, reason: `case ${humanCaseId(caseId)} is "${record.status}", not stopped/failed` };
  }

  const from: CaseStatus = record.stoppedFrom ?? "bs-pipeline";
  if (from === "diagnosing") {
    const updated = await updateCase(caseId, {
      status: "diagnosing",
      stoppedFrom: undefined,
      note: "restarted by you — running the Diagnostician again",
    });
    await announceRestart(updated ?? record, "diagnostician");
    // Fire-and-forget for the same reason Phase A is: this is a multi-minute
    // LLM step and the caller is an HTTP handler.
    void hooks.diagnose(caseId).catch((e) => {
      logger().warn(SELF_HEAL_LOG, "restarted diagnostician failed", { caseId, error: (e as Error).message });
    });
    return { ok: true, changed: true, ...(updated ? { case: updated } : {}) };
  }

  const claimed = await claimInFlightSlot(caseId);
  if (!claimed) {
    const position = await enqueueSlow(caseId);
    const updated = await updateCase(caseId, {
      status: "queued-slow",
      stoppedFrom: undefined,
      note: `restarted by you — another fix holds the pipeline, queued at position ${position}`,
    });
    await announceRestart(updated ?? record, "pipeline");
    return { ok: true, changed: true, ...(updated ? { case: updated } : {}) };
  }

  const conversationId = record.conversationId ?? pipelineConversationId(caseId);
  const agentId = await buildStudioAgentId();
  const updated = await updateCase(caseId, {
    status: "bs-pipeline",
    stoppedFrom: undefined,
    note: "restarted by you — a fresh pipeline run from the last committed artifact",
  });
  await announceRestart(updated ?? record, "pipeline");
  await launchPipeline({
    caseId,
    agentId,
    brief: buildRestartBrief(record),
    conversationId,
    ...(record.activeFeatureBranch ? { featureBranch: record.activeFeatureBranch } : {}),
    costRole: "resume",
  });
  return { ok: true, changed: true, ...(updated ? { case: updated } : {}) };
}

// ── Discard (FR-036) ─────────────────────────────────────────────────────────

export interface DiscardOutcome {
  ok: boolean;
  /** False when there was no such case — a no-op, not an error (R14). */
  discarded: boolean;
  reason?: string;
}

/**
 * Discard a case: kill anything it is running, delete its record, announce it.
 *
 * The one destructive control in the pane, hence the UI's confirm guard — the
 * record and its timeline are gone for good. Two things deliberately survive:
 * the run transcripts (platform artifacts owned by the run layer, ADR-10) and
 * the `case_discarded` event, which carries the status/trigger the case died
 * with precisely because the record can no longer be read.
 */
export async function discardCase(caseId: string): Promise<DiscardOutcome> {
  const record = await getCase(caseId);
  if (!record) return { ok: true, discarded: false, reason: `no case "${caseId}"` };

  // Kill any in-flight run FIRST (cascading to nested children, ADR-11), so a
  // discarded case cannot leave an orphaned run burning the budget. The run-end
  // handler then finds no case and does nothing — every store write is
  // missing-case-safe by construction.
  const heldSlot = (await getInFlightSlowPathCaseId()) === caseId;
  for (const run of (record.runs ?? []).filter((r) => r.status === "in-flight")) {
    abortHeadlessRun(run.runId);
  }

  await deleteCase(caseId);
  logger().info(SELF_HEAL_LOG, "case discarded", { caseId, status: record.status });

  await emitSelfHeal(SELF_HEAL_EVENTS.caseDiscarded, {
    caseId,
    humanId: humanCaseId(caseId),
    status: record.status,
    trigger: record.trigger,
    title: record.title,
    summary: `${humanCaseId(caseId)} discarded — ${record.title}`,
    selfHeal: { role: "lifecycle", caseId },
  });

  // deleteCase already freed the slot atomically; if this case held it, the
  // queue behind it must keep moving, same as Stop.
  if (heldSlot) await dequeueNextEscalation();
  return { ok: true, discarded: true };
}

async function announceRestart(record: HealingCase, role: "diagnostician" | "pipeline"): Promise<void> {
  await emitSelfHeal(SELF_HEAL_EVENTS.runRestarted, {
    ...casePayload(record),
    role,
    summary: summaryFor(record, `restarted — a fresh ${role} run`),
  });
}

/** Start the next queued escalation, if any. The dequeue half of
 *  `releaseSlotAndDequeue`, without the release — the Stop path frees the slot
 *  explicitly (it is not a terminal transition). */
async function dequeueNextEscalation(): Promise<string | undefined> {
  for (;;) {
    const next = await dequeueSlow();
    if (!next) return undefined;
    const record = await getCase(next);
    if (!record || isTerminalStatus(record.status)) continue;
    await escalateCase(next);
    return next;
  }
}

// ── Completion (FR-017, ADR-8) ──────────────────────────────────────────────

export interface CompleteFixInput {
  caseId: string;
  branch?: string;
  appId?: string;
  summary: string;
  link?: string;
  /** Skip the Supervisor readiness check. Only the boot reconcile passes this,
   *  having already established readiness itself. */
  skipPreviewCheck?: boolean;
}

export type CompleteFixOutcome =
  | { ok: true; record: HealingCase; eventId?: string }
  | { ok: false; error: string };

/** Ask the Supervisor whether this branch's preview is actually `ready`. */
export async function previewStateFor(branch: string): Promise<string | undefined> {
  try {
    const { supervisorEnabled, supervisorState } = await import("@/lib/devharness/supervisor");
    if (!supervisorEnabled()) return undefined;
    const state = await supervisorState();
    const previews = (state?.previews ?? []) as { branch?: string; state?: string }[];
    return previews.find((p) => p.branch === branch)?.state;
  } catch {
    return undefined;
  }
}

/**
 * The terminal transition: a healthy preview (or a rebuilt app) with passing
 * tests becomes a `fix_ready` notification the user can act on.
 *
 * The preview state is verified against the Supervisor rather than taken from
 * the agent's word — the agent reports that tests passed (only it knows that),
 * BOS checks that the build is real.
 */
export async function completeFix(input: CompleteFixInput): Promise<CompleteFixOutcome> {
  const record = await getCase(input.caseId);
  if (!record) return { ok: false, error: `no case "${input.caseId}"` };
  if (record.status === "preview-ready") {
    // Idempotent: a redelivered call (or the reconcile racing the agent) must
    // not emit a second fix_ready.
    return { ok: true, record };
  }
  if (isTerminalStatus(record.status)) {
    return { ok: false, error: `case ${input.caseId} is already ${record.status}` };
  }

  const branch = input.branch ?? record.activeFeatureBranch;
  const appId = input.appId ?? record.appId;
  if (!branch && !appId) {
    return { ok: false, error: "a branch (class e) or appId (class d-bis) is required" };
  }

  if (branch && !input.skipPreviewCheck) {
    const state = await previewStateFor(branch);
    // `undefined` means BOS is not running under the Supervisor at all — there
    // is nothing to verify, so the agent's report stands. A KNOWN state that
    // isn't `ready` is a genuine failure and is reported as one.
    if (state !== undefined && state !== "ready") {
      const error = `the preview for ${branch} is "${state}", not ready — fix_ready was not emitted`;
      await updateCase(input.caseId, { status: "failed", error, note: error });
      await releaseSlotAndDequeue(input.caseId);
      return { ok: false, error };
    }
  }

  // FR-038: record the branch head NOW, while the branch still exists — once
  // the user promotes or discards it the ref is gone, and this SHA's ancestry
  // against base is what the boot reconcile settles the case by.
  const fixCommit = branch ? await branchFacts.branchHeadSha(branch).catch(() => undefined) : undefined;

  const link = input.link ?? (branch ? `/?pane=self-heal&caseId=${record.id}` : undefined);
  const updated = await updateCase(input.caseId, {
    status: "preview-ready",
    fixSummary: input.summary,
    ...(link ? { fixLink: link } : {}),
    ...(branch ? { activeFeatureBranch: branch } : {}),
    ...(appId ? { appId } : {}),
    ...(fixCommit ? { fixCommit } : {}),
    note: branch ? `fix ready on ${branch}` : `fix ready — app "${appId}" rebuilt`,
  });
  if (!updated) return { ok: false, error: `case ${input.caseId} disappeared while completing` };

  const eventId = await emitSelfHeal(SELF_HEAL_EVENTS.fixReady, {
    ...casePayload(updated),
    ...(branch ? { branch } : {}),
    ...(appId ? { appId } : {}),
    fixSummary: input.summary,
    ...(link ? { link } : {}),
    summary: summaryFor(updated, branch ? `fix ready on ${branch}` : `fix ready — app "${appId}" rebuilt`),
  });

  // FR-024: BOS never promotes. The slot frees so the next queued fix can start.
  await releaseSlotAndDequeue(input.caseId);
  return { ok: true, record: updated, eventId };
}

// ── Settling a preview-ready case (FR-038) ──────────────────────────────────

export type BranchOutcome = "promoted" | "discarded";

/** Close ONE preview-ready case for a settled branch: `resolved` on promote,
 *  `dismissed` on discard, with the matching lifecycle event. EMIT-AFTER-COMMIT
 *  like every other transition. */
async function settlePreviewReadyCase(record: HealingCase, outcome: BranchOutcome, note: string): Promise<void> {
  const status: CaseStatus = outcome === "promoted" ? "resolved" : "dismissed";
  const updated = await updateCase(record.id, { status, note });
  if (!updated) return;
  const verb = outcome === "promoted" ? "resolved — fix promoted" : "dismissed — fix discarded";
  await emitSelfHeal(outcome === "promoted" ? SELF_HEAL_EVENTS.fixPromoted : SELF_HEAL_EVENTS.fixDiscarded, {
    ...casePayload(updated),
    ...(updated.activeFeatureBranch ? { branch: updated.activeFeatureBranch } : {}),
    outcome,
    summary: summaryFor(updated, verb),
  });
  logger().info(SELF_HEAL_LOG, "preview-ready case settled", {
    caseId: record.id,
    branch: updated.activeFeatureBranch ?? "",
    outcome,
  });
}

/**
 * FR-038(a): the app-side notification. The topbar version controls and the
 * Settings → Versions tab call this (via `POST /api/self-heal?op=branch-settled`)
 * right after a successful promote or discard — every `preview-ready` case
 * linked to that branch closes accordingly. Returns how many cases settled;
 * a branch no case is waiting on is a no-op, not an error.
 */
export async function settleBranchOutcome(branch: string, outcome: BranchOutcome): Promise<number> {
  const target = branch.trim();
  if (!target) return 0;
  const cases = await listCases();
  const matches = cases.filter((c) => c.status === "preview-ready" && c.activeFeatureBranch === target);
  const note =
    outcome === "promoted"
      ? `you promoted ${target} — the fix is live on base`
      : `you discarded ${target} — the fix was thrown away`;
  for (const record of matches) {
    await settlePreviewReadyCase(record, outcome, note);
  }
  return matches.length;
}

// ── Boot reconcile (design R9 / ADR-8's fallback) ───────────────────────────

export interface ReconcileSummary {
  fixReadyEmitted: string[];
  failed: string[];
  abandoned: string[];
  requeued: string[];
  /** Preview-ready cases the FR-038 backstop settled (resolved or dismissed). */
  settled: string[];
}

/**
 * Recover in-flight state after a restart.
 *
 * A process that dies mid-pipeline leaves a case in `bs-pipeline` with no live
 * run, and (worse) holding the single slot. Re-derive the truth from the
 * Supervisor: a `ready` preview with no `fix_ready` yet becomes `preview-ready`
 * (this is the crash-between-build-and-tool window ADR-8 keeps option B for);
 * a `failed` preview becomes `failed`; anything still building is left alone.
 *
 * MUST run single-owner — the caller (src/instrumentation.ts) gates this behind
 * the scheduler's daemon lock so two server processes can't both emit
 * `fix_ready` for the same case.
 */
export async function reconcileInFlightCases(): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { fixReadyEmitted: [], failed: [], abandoned: [], requeued: [], settled: [] };
  summary.abandoned = await sweepSuspendedTimeouts();

  const cases = await listCases();
  for (const record of cases.filter((c) => c.status === "bs-pipeline")) {
    const branch = record.activeFeatureBranch;
    if (!branch) {
      // Class d-bis has no branch to interrogate; the run is gone, so the case
      // is honestly failed rather than left holding the slot forever.
      await updateCase(record.id, {
        status: "failed",
        error: "the pipeline run did not survive a restart",
        note: "boot reconcile: no live run and no preview to check — marked failed (no auto-retry)",
      });
      summary.failed.push(record.id);
      continue;
    }
    const state = await previewStateFor(branch);
    if (state === "ready") {
      const done = await completeFix({
        caseId: record.id,
        branch,
        summary: record.fixSummary ?? `Fix built on ${branch} (recovered after a restart).`,
        skipPreviewCheck: true,
      });
      if (done.ok) summary.fixReadyEmitted.push(record.id);
      continue;
    }
    if (state === "failed") {
      await updateCase(record.id, {
        status: "failed",
        error: `the preview for ${branch} failed to build`,
        note: "boot reconcile: the Supervisor reports a failed preview — marked failed (no auto-retry)",
      });
      summary.failed.push(record.id);
      continue;
    }
    if (state === undefined) {
      // Not under the Supervisor, or the branch has no preview yet: the run is
      // gone either way, so stop holding the slot and record the truth.
      await updateCase(record.id, {
        status: "failed",
        error: "the pipeline run did not survive a restart",
        note: "boot reconcile: no live run and no preview for the branch — marked failed (no auto-retry)",
      });
      summary.failed.push(record.id);
    }
    // `idle`/`building`/`not-built` — still in progress; leave it alone.
  }

  // FR-038(b): the preview-ready sweep. The app-side branch-settled call can be
  // lost (browser closed, or promote restarting base under the request), so on
  // every boot — and promote DOES restart base — a preview-ready case whose
  // branch is gone from the Supervisor's list is settled by git ancestry:
  // `fixCommit` merged into base means promoted, otherwise discarded.
  const previewReady = cases.filter((c) => c.status === "preview-ready" && c.activeFeatureBranch);
  if (previewReady.length > 0) {
    const branches = await branchFacts.listBranches();
    if (branches) {
      for (const record of previewReady) {
        const branch = record.activeFeatureBranch!;
        if (branches.includes(branch)) continue; // still up for review — leave it alone
        // No recorded fixCommit means the merge is unprovable — `dismissed` is
        // the honest default; `resolved` is never claimed on a guess.
        const promoted = record.fixCommit ? await branchFacts.isAncestorOfBase(record.fixCommit) : false;
        await settlePreviewReadyCase(
          record,
          promoted ? "promoted" : "discarded",
          promoted
            ? `boot reconcile: ${branch} is gone and the fix commit is on base — promoted`
            : `boot reconcile: ${branch} is gone and the fix commit is not on base — discarded`,
        );
        summary.settled.push(record.id);
      }
    }
  }

  // Release a slot held by an already-terminal case, then start the queue.
  const index = await readIndex();
  const holder = index.inFlightSlowPathCaseId;
  if (holder) {
    const record = await getCase(holder);
    if (!record || isTerminalStatus(record.status)) {
      const next = await releaseSlotAndDequeue(holder);
      if (next) summary.requeued.push(next);
    }
  } else {
    const next = await releaseSlotAndDequeue();
    if (next) summary.requeued.push(next);
  }
  return summary;
}

// ── Class b/c proposed edits (written by the Diagnostician's tool) ──────────

/** Attach the concrete edit the Diagnostician proposed, so the consent card has
 *  something reviewable to render (FR-010/FR-011, FR-022c). */
export async function setProposedEdit(caseId: string, edit: ProposedEdit): Promise<void> {
  await updateCase(caseId, {
    proposedEdit: edit,
    note: `proposed ${edit.artifactType} edit to ${edit.target}`,
  });
}
