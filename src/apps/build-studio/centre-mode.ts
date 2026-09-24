// 051 T026 — what Build Studio's centre column is showing.
//
// ONE resolved value with a stated precedence, replacing a nested ternary over
// ad-hoc booleans:
//
//     showSelfHeal ? <SelfHealPane/> : showConflictPane ? <ConflictPane/> : <viewer/>
//
// …where `showConflictPane` itself carried `&& !showSelfHeal` to break the tie by
// hand. Two modes need one hand-written exclusion; three need three; the fourth
// (the workflow canvas) would have made it six pairwise interactions, and the one
// that goes wrong is SILENT — two panes claiming the column, or a canvas quietly
// winning over a live conflict session.
//
// Precedence is declared once, here, in the order below. The rule is
// "interruption beats intent": a self-heal case and a conflict session are things
// that HAPPENED and need an answer, so they outrank whatever the user was
// browsing. Between those two, self-heal wins because it can be the reason the
// conflict exists.

export type CentreMode =
  /** An autonomous fix wants a decision (031). */
  | { kind: "self-heal"; caseId?: string }
  /** A merge conflict is being resolved (035 D5). */
  | { kind: "conflict"; sessionId: string }
  /** A workflow's pipeline (051). */
  | { kind: "workflow"; workflowId: string }
  /** The default: whatever artifact is selected in the tree. */
  | { kind: "artifact" };

export interface CentreInputs {
  selfHeal: { active: boolean; caseId?: string };
  conflict: { sessionId: string; dismissed: boolean };
  workflowId: string;
}

/**
 * The single place that decides what the centre column shows.
 *
 * Pure and total: every combination of inputs yields exactly one mode, so there
 * is no arrangement in which two panes both believe they own the column, and
 * none in which none of them do.
 */
export function resolveCentreMode(input: CentreInputs): CentreMode {
  if (input.selfHeal.active) return { kind: "self-heal", caseId: input.selfHeal.caseId };
  if (input.conflict.sessionId && !input.conflict.dismissed) {
    return { kind: "conflict", sessionId: input.conflict.sessionId };
  }
  // Below the interruptions: the user chose this, so anything urgent outranks it.
  if (input.workflowId) return { kind: "workflow", workflowId: input.workflowId };
  return { kind: "artifact" };
}
