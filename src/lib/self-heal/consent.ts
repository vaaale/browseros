import "server-only";
import * as vfs from "@/os/vfs";
import { logger } from "@/lib/logging";
import { getCase, updateCase } from "./store";
import { emitSelfHeal, casePayload, summaryFor, SELF_HEAL_LOG } from "./events";
import { SELF_HEAL_EVENTS, type HealingCase, type ProposedEdit } from "./types";

// Consent-gated application of a class-b / class-c fix (031-self-healing
// FR-010/FR-011, FR-022c).
//
// Classes b and c are the only ones the mechanism applies IN PLACE — a skill
// body or a workflow definition, not source code. That makes the consent gate
// the whole safety story here: unlike class e (which lands on a preview branch
// the user promotes) there is no second checkpoint afterwards.
//
// So the gate is structural, not advisory: `applyApprovedEdit` refuses unless
// the case is sitting in `awaiting-consent` WITH a stored `proposedEdit`. A
// case in any other state — not yet diagnosed, already applied, dismissed,
// escalated — is left completely untouched. There is no force flag.

export type ConsentOutcome =
  | { ok: true; record: HealingCase; target: string }
  | { ok: false; error: string };

/** Workflow definitions live in the VFS at `/Workflows/<id>.json` (the 002
 *  Workflow Manager item's store). Class-c edits are confined to that subtree
 *  so an approved "workflow edit" can never reach anything else. */
const WORKFLOW_DIR = "/Workflows";

function isWorkflowPath(target: string): boolean {
  return target.startsWith(`${WORKFLOW_DIR}/`) && target.endsWith(".json") && !target.includes("..");
}

async function applySkillEdit(edit: ProposedEdit): Promise<{ ok: true } | { ok: false; error: string }> {
  const { patchSkill } = await import("@/lib/agent/skills/store");
  const result = await patchSkill(edit.target, edit.before, edit.after);
  if ("error" in result) return { ok: false, error: result.error };
  return { ok: true };
}

async function applyWorkflowEdit(edit: ProposedEdit): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isWorkflowPath(edit.target)) {
    return { ok: false, error: `"${edit.target}" is not a workflow definition under ${WORKFLOW_DIR}/` };
  }
  let current: string;
  try {
    current = await vfs.readText(edit.target);
  } catch {
    return { ok: false, error: `no workflow definition at ${edit.target}` };
  }
  if (!current.includes(edit.before)) {
    return { ok: false, error: `the proposed \`before\` text is not present in ${edit.target} — the definition changed since diagnosis` };
  }
  const next = current.replace(edit.before, edit.after);
  // Refuse to write a definition that is no longer valid JSON: a broken
  // workflow file is worse than an unfixed one.
  try {
    JSON.parse(next);
  } catch (err) {
    return { ok: false, error: `the edit would make ${edit.target} invalid JSON (${(err as Error).message})` };
  }
  await vfs.writeText(edit.target, next);
  return { ok: true };
}

/**
 * Apply the case's stored proposed edit, after the user approved it.
 *
 * Consent-gated (FR-010/FR-011): only a case in `awaiting-consent` with a
 * stored edit is applicable. On success the case reaches the terminal `applied`
 * state and emits `case_closed`; on failure the case STAYS in
 * `awaiting-consent` (with the reason on its timeline) so the user can see what
 * went wrong and dismiss it deliberately.
 */
export async function applyApprovedEdit(caseId: string): Promise<ConsentOutcome> {
  const record = await getCase(caseId);
  if (!record) return { ok: false, error: `no case "${caseId}"` };
  if (record.status !== "awaiting-consent") {
    return { ok: false, error: `case ${caseId} is "${record.status}", not awaiting consent — nothing was changed` };
  }
  const edit = record.proposedEdit;
  if (!edit) {
    return { ok: false, error: `case ${caseId} has no proposed edit to apply — nothing was changed` };
  }

  const result = edit.artifactType === "skill" ? await applySkillEdit(edit) : await applyWorkflowEdit(edit);
  if (!result.ok) {
    await updateCase(caseId, { note: `approved edit could not be applied: ${result.error}` });
    logger().warn(SELF_HEAL_LOG, "consent apply failed", { caseId, error: result.error });
    return { ok: false, error: result.error };
  }

  const updated = await updateCase(caseId, {
    status: "applied",
    note: `approved ${edit.artifactType} edit applied to ${edit.target}`,
  });
  if (!updated) return { ok: false, error: `case ${caseId} disappeared while applying` };
  await emitSelfHeal(SELF_HEAL_EVENTS.caseClosed, {
    ...casePayload(updated),
    resolution: "applied",
    target: edit.target,
    summary: summaryFor(updated, `applied a ${edit.artifactType} edit to ${edit.target}`),
  });
  return { ok: true, record: updated, target: edit.target };
}

/** Close a case without applying anything (the "Dismiss" button, and the
 *  user discarding a preview). Terminal, and it releases the slow-path slot via
 *  `updateCase`'s terminal handling. */
export async function dismissCase(caseId: string, reason?: string): Promise<ConsentOutcome> {
  const record = await getCase(caseId);
  if (!record) return { ok: false, error: `no case "${caseId}"` };
  const updated = await updateCase(caseId, {
    status: "dismissed",
    note: reason ? `dismissed: ${reason}` : "dismissed by the user",
  });
  if (!updated) return { ok: false, error: `case ${caseId} disappeared while dismissing` };
  await emitSelfHeal(SELF_HEAL_EVENTS.caseClosed, {
    ...casePayload(updated),
    resolution: "dismissed",
    ...(reason ? { reason } : {}),
    summary: summaryFor(updated, "dismissed"),
  });
  // A dismissed slow-path case frees the single pipeline slot for the next one.
  const { releaseSlotAndDequeue } = await import("./intake");
  await releaseSlotAndDequeue(caseId);
  return { ok: true, record: updated, target: record.proposedEdit?.target ?? "" };
}
