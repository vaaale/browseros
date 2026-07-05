// Category-based ACL for the Unified Job Engine (spec FR-017).
//
// Storage is unified across categories; behaviour is not. This module is the
// single source of truth for "what may a user do with this job?" — used by
// both the API (server-side enforcement) and the UI (which greys buttons out).
//
// Rules from the spec:
//   user         — full control
//   system       — view + pause/resume + run-now; interval editable if the
//                  owning subsystem allows it; name/prompt/handler read-only;
//                  delete disabled (systems recreate on boot via ensureSystemJob)
//   integration  — view + pause/resume + interval-edit + run-now; handler,
//                  integrationRef, target are read-only (integration owns them);
//                  delete disabled from the scheduler UI (integration uninstall
//                  cascades and removes its jobs).
//
// Per-job `readOnlyFields` tightens further — never widens.

import type { JobDefinition, JobCategory, UpdateJobInput } from "./types";

export type JobAction = "run-now" | "pause" | "resume" | "edit" | "delete";

// A job's fields that user-facing edits ever attempt to change. Kept in sync
// with UpdateJobInput. `interval` is a synthetic field name mapping to
// scheduleConfig for recurring jobs.
export type EditableField = "name" | "handler" | "scheduleConfig" | "interval";

interface CategoryAcl {
  canDelete: boolean;
  editableFields: ReadonlySet<EditableField>;
  actions: ReadonlySet<JobAction>;
}

const CATEGORY_DEFAULTS: Record<JobCategory, CategoryAcl> = {
  user: {
    canDelete: true,
    editableFields: new Set(["name", "handler", "scheduleConfig", "interval"]),
    actions: new Set(["run-now", "pause", "resume", "edit", "delete"]),
  },
  system: {
    canDelete: false,
    // Interval only; the owning subsystem is expected to declare its handler
    // and name at seed time and never let the user retype them.
    editableFields: new Set(["interval", "scheduleConfig"]),
    actions: new Set(["run-now", "pause", "resume", "edit"]),
  },
  integration: {
    canDelete: false,
    // Interval / scheduleConfig only. The integration adapter owns the
    // handler wiring; letting the user retype `integrationId` or `action`
    // would silently break the poll.
    editableFields: new Set(["interval", "scheduleConfig"]),
    actions: new Set(["run-now", "pause", "resume", "edit"]),
  },
};

/**
 * Fields that CAN be edited for this specific job, factoring in category
 * defaults AND per-job readOnlyFields. Returned as a plain string array so it
 * is JSON-serialisable to the UI.
 */
export function getEditableFields(job: JobDefinition): EditableField[] {
  const acl = CATEGORY_DEFAULTS[job.category];
  const readOnly = new Set(job.readOnlyFields ?? []);
  return Array.from(acl.editableFields).filter((f) => !readOnly.has(f));
}

/** May the user invoke this action on this job right now? */
export function canPerformAction(job: JobDefinition, action: JobAction): boolean {
  const acl = CATEGORY_DEFAULTS[job.category];
  if (action === "delete") return acl.canDelete;
  return acl.actions.has(action);
}

/**
 * Validate an incoming update against the ACL. Returns null if the update is
 * permitted, otherwise a human-readable error naming the offending field.
 * Callers should reject the whole request on any non-null return.
 */
export function validateUpdate(job: JobDefinition, updates: UpdateJobInput): string | null {
  const allowed = new Set(getEditableFields(job));
  if (updates.name !== undefined && !allowed.has("name")) {
    return `Cannot edit name on ${job.category} job "${job.name}"`;
  }
  if (updates.handler !== undefined && !allowed.has("handler")) {
    return `Cannot edit handler on ${job.category} job "${job.name}"`;
  }
  if (updates.scheduleConfig !== undefined) {
    // Recurring: interval field ACL applies. One-time: full scheduleConfig ACL.
    const wanted: EditableField =
      updates.scheduleConfig.type === "recurring" ? "interval" : "scheduleConfig";
    if (!allowed.has(wanted)) {
      return `Cannot edit schedule on ${job.category} job "${job.name}"`;
    }
  }
  return null;
}

/**
 * Assert a job may be deleted from the scheduler UI. System/integration jobs
 * MUST be removed by their owning subsystem, not the user.
 */
export function assertDeletable(job: JobDefinition): void {
  if (!canPerformAction(job, "delete")) {
    throw new Error(
      `Cannot delete ${job.category} job "${job.name}" — it is managed by ${job.owner ?? job.category}`,
    );
  }
}
