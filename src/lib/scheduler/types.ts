// Scheduler types shared between server and client. Framework-free — no Node
// or React imports so it is safe on either side.
//
// This is the Unified Job Engine schema (specs/bos-system-specs/scheduler).
// Every scheduled unit of work — System loops, User agent prompts, and
// Integration polls — is a `JobDefinition` persisted to a single VFS store at
// `/Documents/System/scheduler-jobs.json`. The `category` field drives UI/ACL
// behaviour only; storage and dispatch pathways are unified.

// ── Schedule primitives ───────────────────────────────────────────────────

export type ScheduleType = "one-time" | "recurring";
export type RecurringUnit = "minute" | "hour" | "day" | "week";

export interface OneTimeSchedule {
  type: "one-time";
  datetime: string;
}

export interface RecurringSchedule {
  type: "recurring";
  interval: number;
  unit: RecurringUnit;
  startTime?: string;
}

export type ScheduleConfig = OneTimeSchedule | RecurringSchedule;

// ── Execution history ─────────────────────────────────────────────────────

export type ExecutionStatus = "success" | "error";

export interface JobExecution {
  id: string;
  jobId: string;
  executedAt: string;
  status: ExecutionStatus;
  duration: number;
  output?: string;
  error?: string;
}

// ── Handlers ──────────────────────────────────────────────────────────────
//
// A handler tells the engine HOW to run a job. Kinds are open — new handlers
// register at runtime via `engine.registerHandler(...)`. The persisted shape is
// a discriminated union keyed by `kind`.

export type HandlerKind = "prompt" | "internal" | "integration";

export interface PromptHandler {
  kind: "prompt";
  prompt: string;
  agentId: string;
}

export interface InternalHandler {
  kind: "internal";
  ref: string;
}

export interface IntegrationHandler {
  kind: "integration";
  integrationId: string;
  action: string;
}

export type JobHandler = PromptHandler | InternalHandler | IntegrationHandler;

// ── JobDefinition ─────────────────────────────────────────────────────────

export type JobCategory = "system" | "user" | "integration";
export type JobStatus = "active" | "paused" | "completed";

export interface JobDefinition {
  id: string;
  name: string;
  category: JobCategory;
  handler: JobHandler;
  scheduleType: ScheduleType;
  scheduleConfig: ScheduleConfig;
  status: JobStatus;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastExecutedAt?: string;
  // Subsystem/integration id that manages this job (informational; storage is
  // unified). Enables uninstall cascade for integrations.
  owner?: string;
  // Field names the UI must not let the user edit for this specific job.
  // Enforcement layers on top of the category default ACL (see acl.ts).
  readOnlyFields?: string[];
  // One-time jobs may opt to be removed rather than marked completed.
  deleteAfterExecution?: boolean;
}

export interface JobDefinitionWithHistory extends JobDefinition {
  history: JobExecution[];
}

// Input shapes ────────────────────────────────────────────────────────────

export interface CreateJobInput {
  name: string;
  category?: JobCategory;
  handler: JobHandler;
  scheduleConfig: ScheduleConfig;
  owner?: string;
  readOnlyFields?: string[];
  deleteAfterExecution?: boolean;
  // Explicit id (idempotent seeding for system/integration jobs). If omitted,
  // a UUID is generated.
  id?: string;
}

export interface UpdateJobInput {
  name?: string;
  handler?: JobHandler;
  scheduleConfig?: ScheduleConfig;
  deleteAfterExecution?: boolean;
}

// ── Legacy shape (used only by the migration module) ─────────────────────
//
// The v0 store persisted flat Task records with `prompt`+`agentId` at the top
// level. `migrate.ts` reads that shape once at first boot and lifts it into
// the unified JobDefinition schema. All other code MUST use JobDefinition.

export interface LegacyTaskV0 {
  id: string;
  name: string;
  prompt: string;
  agentId: string;
  scheduleType: ScheduleType;
  scheduleConfig: ScheduleConfig;
  status: JobStatus;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastExecutedAt?: string;
  deleteAfterExecution?: boolean;
}
