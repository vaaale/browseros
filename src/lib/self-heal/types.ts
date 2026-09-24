// Framework-free shared types for the Self-Healing Mechanism
// (031-self-healing). Imported by the server-only spine, the API route, the
// Build Studio Self-Heal pane and the Settings tab — no React, no Node
// imports. See specs/user-specs/self-modification/031-self-healing/design.md
// §3.3 (Component) and §3.4 (the state machine).

/** The six fix surfaces a diagnosed problem can map to (FR-007).
 *  a = environmental (no durable change), b = agent misuse / skill gap,
 *  c = workflow or data gap, d = marketplace app the user does NOT own,
 *  d-bis = marketplace app the user DOES own, e = BOS core gap. */
export type ScopeClass = "a" | "b" | "c" | "d" | "d-bis" | "e";

export const SCOPE_CLASSES: readonly ScopeClass[] = ["a", "b", "c", "d", "d-bis", "e"];

/** Who owns the surface the fix would land on (FR-007). */
export type Ownership = "bos-core" | "user-app" | "marketplace" | "workflow" | "env";

export const OWNERSHIPS: readonly Ownership[] = ["bos-core", "user-app", "marketplace", "workflow", "env"];

/** The five trigger types (FR-002..FR-006), each independently toggleable. */
export type TriggerType = "explicit" | "hard-error" | "repeated-failure" | "workflow-timeout" | "log-events";

export const TRIGGER_TYPES: readonly TriggerType[] = [
  "explicit",
  "hard-error",
  "repeated-failure",
  "workflow-timeout",
  "log-events",
];

/**
 * The case state machine (FR-018, design §3.4):
 *
 *   new → diagnosing → diagnosed ─┬─ env-only                            [terminal]
 *                                 ├─ awaiting-consent → applied | dismissed
 *                                 ├─ notified                            [terminal]
 *                                 └─ queued-slow → bs-pipeline ─┬─ preview-ready ─┬─ resolved  [terminal]
 *                                                               │  (FR-038)       └─ dismissed [terminal]
 *                                                               ├─ failed        [terminal]
 *                                                               ├─ dismissed     [terminal]
 *                                                               └─ suspended → (resume) bs-pipeline
 *                                                                            └─ abandoned [terminal]
 *
 * `queued-cost` is the pre-diagnosis parking state for a case admitted while
 * the daily cost cap was already exhausted (FR-020 queues, never drops).
 *
 * `stopped` (031-self-healing scope-add, FR-018/FR-034) is a NON-terminal,
 * recoverable pause of a live run, reachable from the two states that HAVE one:
 *
 *   diagnosing ──Stop──► stopped ──Start──► diagnosing
 *   bs-pipeline ─Stop──► stopped ──Start──► bs-pipeline (or queued-slow)
 *
 * It is entered by the user's Stop, or by the run-end handler for a run that
 * already ended on max-steps (FR-033(b)); `stoppedFrom` records which state to
 * restore. Unlike `suspended` it FREES the slow-path slot — a stopped run
 * consumes nothing, and holding the single slot would block every other fix for
 * as long as the user leaves it stopped (design ADR-13).
 */
export type CaseStatus =
  | "new"
  | "queued-cost"
  | "diagnosing"
  | "diagnosed"
  | "env-only"
  | "awaiting-consent"
  | "applied"
  | "notified"
  | "queued-slow"
  | "bs-pipeline"
  | "suspended"
  | "stopped"
  | "preview-ready"
  | "resolved"
  | "dismissed"
  | "failed"
  | "abandoned";

/** Statuses no transition ever leaves (the slow-path slot is released on all
 *  of these — design ADR-9). */
export const TERMINAL_STATUSES: readonly CaseStatus[] = [
  "env-only",
  "applied",
  "notified",
  "preview-ready",
  "resolved",
  "dismissed",
  "failed",
  "abandoned",
];

export function isTerminalStatus(status: CaseStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Coarse error buckets for the dedupe key (FR-019, ADR-7). Deliberately few:
 *  the bucket exists to group "the same kind of failure", not to describe it. */
export type ErrorCategory =
  | "timeout"
  | "not_found"
  | "permission_denied"
  | "type_mismatch"
  | "auth"
  | "rate_limit"
  | "explicit"
  | "unhandled_exception";

/** A normalized failure identity, computed deterministically BEFORE diagnosis
 *  (FR-019) so a duplicate never spends Diagnostician tokens. */
export interface FailureSignature {
  /** The tool (or pseudo-tool, e.g. `workflow:<id>`) the failure came from. */
  toolName: string;
  errorCategory: ErrorCategory;
  /** SHA-256 hex of the normalized message (see signature.ts). */
  normalizedHash: string;
  /** `<toolName>:<errorCategory>:<normalizedHash>` — the dedupe map key. */
  dedupeKey: string;
  /** Human-readable one-liner for the case list / report frontmatter. */
  label: string;
}

/** What a trigger hands the spine's front door. */
export interface TriggerContext {
  trigger: TriggerType;
  /** Free-text problem description (the explicit trigger's payload). */
  description?: string;
  toolName?: string;
  errorMessage?: string;
  /** Node exception code / class name, when known (`EACCES`, `TimeoutError`). */
  errorCode?: string;
  /** HTTP status, when the failure came from an HTTP call. */
  httpStatus?: number;
  conversationId?: string;
  eventId?: string;
  filePath?: string;
  appId?: string;
  /** Logging component namespace, for the log-events trigger (FR-005). */
  component?: string;
  /** Workflow-timeout trigger detail (FR-004). */
  workflow?: { id: string; node?: string; configuredMs?: number; actualMs?: number };
  /** Repeated-failure trigger detail (FR-003). */
  repeated?: { count: number; windowSec: number };
  /** Anything else the trigger knows; surfaced verbatim to the Diagnostician. */
  extra?: Record<string, unknown>;
}

export interface TimelineEntry {
  at: number;
  status: CaseStatus;
  /** Short, human-readable reason for the transition. */
  note?: string;
}

/** A concrete, reviewable edit the Diagnostician proposes for class b / c
 *  (FR-010/FR-011). Application is consent-gated (see consent.ts). */
export interface ProposedEdit {
  /** `skill` → a skill body patch; `workflow` → a `/Workflows/*.json` patch. */
  artifactType: "skill" | "workflow";
  /** Skill id, or the VFS path of the workflow definition. */
  target: string;
  /** Exact existing text to replace (must match once). */
  before: string;
  /** Exact replacement text. */
  after: string;
  rationale?: string;
}

/** Which of the two runs the spine launches this is (FR-022f, ADR-14). */
export type CaseRunRole = "diagnostician" | "pipeline";

/** A linked run's lifecycle, as the case sees it. `stopped` is the run entry's
 *  counterpart of a max-steps end the user has not restarted yet; `aborted` is
 *  a run the user's Stop actually killed. */
export type CaseRunStatus = "in-flight" | "completed" | "failed" | "aborted" | "stopped";

/** One headless run linked to a case (031-self-healing scope-add, ADR-14).
 *
 *  The CASE is the source of truth for "this case's runs" — the transcript file
 *  carries `caseId` so it is self-describing, but the UI reads this list, so
 *  listing a case's runs is never a filesystem scan. Appended on the run's
 *  leading `run_started` event, which is why the case knows the runId while the
 *  run is still in flight (and therefore stoppable). */
export interface CaseRun {
  runId: string;
  agentId: string;
  agentName?: string;
  role: CaseRunRole;
  status: CaseRunStatus;
  startedAt: number;
  endedAt?: number;
  /** Set on the run the detector fired for. */
  stuck?: StuckSignature;
}

/** What the stuck detector found (FR-033). Recorded on the case so the pane can
 *  render the amber indicator and highlight the repeated lines in the
 *  transcript — the transcript FILE stays free of any detector concept. */
export interface StuckSignature {
  runId: string;
  reason: "repeat-calls" | "max-steps";
  /** Empty for a max-steps end: nothing single was being repeated. */
  tool: string;
  normalizedInput: string;
  count: number;
  at: number;
}

/** The durable record of ONE self-heal invocation (FR-018). */
export interface HealingCase {
  /** A single lowercase `[a-z0-9]+` segment, so `bos/self-heal-<id>` is a valid
   *  feature branch (design ADR-3). The UI renders it with an `EHS-` prefix. */
  id: string;
  trigger: TriggerType;
  /** One-line human title, derived at intake from the trigger context. */
  title: string;
  signature: FailureSignature;
  context: TriggerContext;
  status: CaseStatus;
  createdAt: number;
  updatedAt: number;
  scopeClass?: ScopeClass;
  ownership?: Ownership;
  proposedSurface?: string;
  /** VFS path of the markdown diagnostics report (FR-028). */
  reportPath?: string;
  /** Verdict line from the report: "genuine gap" or "usage/agent error". */
  verdict?: string;
  /** The BS conversation the slow path runs in. */
  conversationId?: string;
  /** `bos/self-heal-<id>` for class e (FR-015b). */
  activeFeatureBranch?: string;
  /** The user-owned item id for class d-bis (FR-013). */
  appId?: string;
  /** Class b/c: the edit awaiting the user's consent. */
  proposedEdit?: ProposedEdit;
  /** Set while `suspended` (FR-016). */
  pendingQuestion?: string;
  suspendedAt?: number;
  /** The user's answer, once given. */
  decisionAnswer?: string;
  /** Set when a fix is ready (FR-017). */
  fixSummary?: string;
  fixLink?: string;
  /** The feature branch's head SHA at completeFix time (FR-038) — what the
   *  boot reconcile checks against base ancestry once the branch itself is
   *  gone, to tell a promote from a discard. */
  fixCommit?: string;
  /** The case this one duplicates, when suppressed by dedupe (FR-019). */
  duplicateOf?: string;
  /** Terminal-failure detail (build/test failure, abandoned, …). */
  error?: string;
  /** Every headless run this case has launched, oldest first (scope-add). */
  runs?: CaseRun[];
  /** The in-flight state a Stop came from, so Start restores THAT state and
   *  relaunches THAT role (FR-018/FR-034). */
  stoppedFrom?: CaseStatus;
  /** Set when the stuck detector fired on one of this case's runs (FR-033). */
  stuckSignature?: StuckSignature;
  timeline: TimelineEntry[];
}

/** One day's worth of LLM spend attributable to self-heal (FR-020, ADR-5). */
export interface CostLedgerEntry {
  caseId: string;
  /** Which run spent it. */
  role: "diagnostician" | "pipeline" | "resume";
  tokens: number;
  /** True when derived from a fallback estimate (provider omitted usage). */
  estimated?: boolean;
  at: number;
}

/** `signature → most recent case` (FR-019). */
export interface DedupeEntry {
  dedupeKey: string;
  caseId: string;
  status: CaseStatus;
  at: number;
}

export interface QueueEntry {
  caseId: string;
  at: number;
}

/** The warm index — `data/self-heal/index.json`. Single source of truth for the
 *  in-flight slot, the dedupe map, the cost ledger and both bounded queues
 *  (design ADR-6/ADR-9). */
export interface SelfHealIndex {
  version: 1;
  /** Monotonic counter behind `id` (zero-padded to four digits). */
  nextCaseSeq: number;
  /** id → status, so the pane's list view needs no per-case read. */
  cases: Record<string, { status: CaseStatus; updatedAt: number }>;
  dedupe: Record<string, DedupeEntry>;
  ledger: CostLedgerEntry[];
  /** Exactly one case may be in `bs-pipeline`/`suspended` (FR-015c). */
  inFlightSlowPathCaseId: string | null;
  /** FIFO behind the slot. */
  slowQueue: QueueEntry[];
  /** FIFO of cases admitted while the daily cap was exhausted (FR-020). */
  costQueue: QueueEntry[];
}

export function emptyIndex(): SelfHealIndex {
  return {
    version: 1,
    nextCaseSeq: 1,
    cases: {},
    dedupe: {},
    ledger: [],
    inFlightSlowPathCaseId: null,
    slowQueue: [],
    costQueue: [],
  };
}

// ── Configuration (FR-027) ──────────────────────────────────────────────────

export interface SelfHealConfig {
  enabled: boolean;
  triggers: Record<TriggerType, boolean>;
  diagnostician: { scheduled: boolean; idleThresholdSec: number };
  autonomousImplement: boolean;
  tdd: { required: boolean; targetCoverage: number };
  costCapPerDay: number;
  dedupeWindowSec: number;
  /** Shorter window for the explicit trigger — re-firing a report is usually
   *  intentional (FR-019). */
  explicitDedupeWindowSec: number;
  suspendedTimeoutDays: number;
  costQueueMax: number;
  costQueueTtlDays: number;
  /** Repeated-failure threshold + window (FR-003). */
  repeatedFailure: { count: number; windowSec: number };
  /** How many non-environmental failures within the repeated-failure window
   *  the hard-error trigger needs before it fires (FR-002 amended). 1 (the
   *  default) keeps the original single-failure behavior; below the count the
   *  failure is logged at info level, never a case. */
  hardError: { minCount: number };
  /** Stuck-run detection on the runs the spine launches (FR-033). `enabled`
   *  off means no `run_stuck` and no amber indicator — Stop still works, it is
   *  a separate control. */
  stuckDetector: { enabled: boolean; repeatCalls: number };
}

export const SELF_HEAL_DEFAULTS: SelfHealConfig = {
  enabled: true,
  triggers: {
    explicit: true,
    // A fresh install is conservative: only the explicit trigger is on (US5).
    "hard-error": false,
    "repeated-failure": false,
    "workflow-timeout": false,
    "log-events": false,
  },
  diagnostician: { scheduled: false, idleThresholdSec: 300 },
  autonomousImplement: true,
  tdd: { required: true, targetCoverage: 95 },
  // User-confirmed 2026-09-07 (design R5): enough for several full
  // Diagnostician + BS pipeline + Developer runs a day, low enough to be a
  // real guard.
  costCapPerDay: 1_000_000,
  dedupeWindowSec: 86_400,
  explicitDedupeWindowSec: 3_600,
  suspendedTimeoutDays: 7,
  costQueueMax: 100,
  costQueueTtlDays: 7,
  repeatedFailure: { count: 3, windowSec: 300 },
  hardError: { minCount: 1 },
  stuckDetector: { enabled: true, repeatCalls: 5 },
};

// ── Events (FR-026) ─────────────────────────────────────────────────────────

export const SELF_HEAL_EVENT_SOURCE = { appId: "self-heal", name: "Self-Healing", icon: "HeartPulse" };

/** Every lifecycle event the spine emits, plus the two it subscribes to. */
export const SELF_HEAL_EVENTS = {
  /** Intake (any trigger) — the spine's own front door event. */
  trigger: "com.bos.self-heal.trigger",
  caseCreated: "com.bos.self-heal.case_created",
  caseEscalated: "com.bos.self-heal.case_escalated",
  dedupeSuppressed: "com.bos.self-heal.dedupe_suppressed",
  costCapEvicted: "com.bos.self-heal.cost_cap_evicted",
  decisionNeeded: "com.bos.self-heal.decision_needed",
  decisionResolved: "com.bos.self-heal.decision_resolved",
  fixReady: "com.bos.self-heal.fix_ready",
  /** FR-038: a preview-ready case's branch was promoted (→ `resolved`) or
   *  discarded (→ `dismissed`) — via the app-side branch-settled notification
   *  or the boot-reconcile backstop. */
  fixPromoted: "com.bos.self-heal.fix_promoted",
  fixDiscarded: "com.bos.self-heal.fix_discarded",
  abandoned: "com.bos.self-heal.abandoned",
  appNotify: "com.bos.self-heal.app_bug_notice",
  caseClosed: "com.bos.self-heal.case_closed",
  /** Scope-add (FR-026/FR-033/FR-034). These are lifecycle events ON A CASE —
   *  never triggers. `run_stuck` in particular carries `selfHeal.role`, so the
   *  intake filter would drop it even if something tried to re-enter through it
   *  (FR-035's defense in depth). */
  runStuck: "com.bos.self-heal.run_stuck",
  runAborted: "com.bos.self-heal.run_aborted",
  runRestarted: "com.bos.self-heal.run_restarted",
  /** FR-036: the case record was deleted at the user's request. Carries the
   *  status the case had at discard — the record itself is gone. */
  caseDiscarded: "com.bos.self-heal.case_discarded",
} as const;

/** The `prefix.*` pattern the spine registers its core headless handler for. */
export const SELF_HEAL_EVENT_NAMESPACE = "com.bos.self-heal.*";

/** Display metadata for the six scope classes — the binding visual vocabulary
 *  from mockup.html §4 (design §8). One object, used by the list, the detail
 *  header and the legend so the badge is the same thing everywhere. */
export const SCOPE_CLASS_META: Record<ScopeClass, { label: string; kind: string; ownership: Ownership; tone: string }> = {
  a: { label: "Env", kind: "no change", ownership: "env", tone: "gray" },
  b: { label: "Skill", kind: "patch skill", ownership: "bos-core", tone: "violet" },
  c: { label: "Workflow", kind: "edit def", ownership: "workflow", tone: "blue" },
  d: { label: "Notify", kind: "not owned", ownership: "marketplace", tone: "amber" },
  "d-bis": { label: "App", kind: "app_build", ownership: "user-app", tone: "pink" },
  e: { label: "Core", kind: "feature branch", ownership: "bos-core", tone: "emerald" },
};

/** Presentation-only human prefix over the canonical `caseId` (design ADR-3).
 *  NEVER part of the branch name. */
export function humanCaseId(caseId: string): string {
  return `EHS-${caseId}`;
}

/** The deterministic feature branch for a class-e case (FR-015b). Valid against
 *  `FEATURE_BRANCH_RE` precisely because `caseId` is one `[a-z0-9]+` segment. */
export function selfHealBranchFor(caseId: string): string {
  return `bos/self-heal-${caseId.toLowerCase()}`;
}
