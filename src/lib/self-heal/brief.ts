// The autonomous Build Studio brief (031-self-healing FR-014/FR-015/FR-015a).
//
// This text IS the mechanism for the slow path's three hardest requirements —
// there is no code that can enforce them from outside a delegated agent's run:
//   FR-015  run the whole pipeline without stopping at step boundaries, and
//           commit every confirmed decision to its artifact BEFORE advancing;
//   FR-015a verify at plan→tasks that the plan's files match the Diagnostician's
//           proposedSurface, with exactly ONE re-diagnosis and no further LLM
//           arbitration;
//   FR-014  TDD, a coverage target, and the plan's file list as a HARD scope
//           constraint the converge step re-checks.
//
// Kept in its own module (not inlined in intake.ts) because it is a contract
// that will be read and edited by humans far more often than the routing code
// around it, and because it is worth being able to assert on in a test.

import { humanCaseId, selfHealBranchFor, type HealingCase, type SelfHealConfig } from "./types";

export interface BriefInput {
  record: HealingCase;
  cfg: SelfHealConfig;
  /** The Diagnostician's markdown report body — passed as USER INTENT, not as
   *  a spec (clarification C3): the `specify` step must produce a real spec.md
   *  from it. */
  reportBody: string;
  /** Set for class e; absent for class d-bis (which delivers via app_build). */
  featureBranch?: string;
}

function preAuthorization(): string[] {
  return [
    "## Pre-authorization",
    "",
    // FR-015's sentence, verbatim and unbroken — it is the instruction that
    // overrides the agent's default stop-at-every-step contract, so it must not
    // be paraphrased or split by markdown.
    "The user has pre-authorized this fix. Run the full pipeline autonomously. Stop only if you encounter a decision you cannot resolve autonomously.",
    "",
    "Concretely: do NOT stop after ANY pipeline step of the active method to ask",
    "whether to continue. Run each step and move",
    "straight to the next. This overrides your default stop-after-every-step",
    "contract **for this conversation only** — your agent definition is unchanged",
    "and every other Build Studio conversation still stops for the user.",
    "",
    "When you genuinely cannot decide, call `self_heal_request_decision` with the",
    "question and the case id. That suspends the case, notifies the user, and ends",
    "this run; a new run resumes here with their answer once they reply. Asking",
    "through that tool is the ONLY correct way to stop — never park on a message",
    "and wait, because there is no user watching this conversation.",
  ];
}

function commitBeforeAdvance(): string[] {
  return [
    "## Commit-before-advance (FR-015)",
    "",
    "Any decision that gets confirmed — a scope choice, an architectural call, a design",
    "constraint — MUST be written into the current artifact immediately, whatever",
    "the active method calls it: before you ask the next question, and before you move to",
    "the next step. Nothing may live only in the conversation.",
    "",
    "This is what makes a cold restart safe: if this run dies (BOS restarts, the",
    "token limit hits, the window closes), the next run reads the artifacts on disk",
    "and recovers every confirmed decision. A decision that exists only in chat is",
    "a decision that will be silently lost and re-guessed.",
  ];
}

function classificationVerification(proposedSurface: string): string[] {
  return [
    "## Classification verification at plan → tasks (FR-015a)",
    "",
    `The Diagnostician's \`proposedSurface\` is: **${proposedSurface}**`,
    "",
    "After you write `plan.md`, and BEFORE you write `tasks.md`:",
    "",
    "1. Compare the plan's file list against that `proposedSurface`. A divergence is",
    "   the plan touching a subsystem the proposed surface does not reference — a",
    "   different top-level `src/` directory, a different `seed/agents/<id>`, a",
    "   different `src/apps/<id>`.",
    "2. On divergence, make **exactly ONE** re-diagnosis attempt:",
    "   `agent_delegate(conversation-reviewer, …)` with the plan's file list, the",
    "   original `proposedSurface`, and the question \"do these files plausibly",
    "   implement the proposed surface? answer 'confirmed' or 'diverges: <reason>'\".",
    "3. If it answers `confirmed`, proceed to `tasks`. If it answers `diverges`, call",
    "   `self_heal_request_decision` with the justification for each divergent file.",
    "   **Do not attempt a second re-diagnosis.** A second disagreement is never",
    "   resolved by further LLM arbitration — it goes to the user.",
  ];
}

function developerMandate(cfg: SelfHealConfig): string[] {
  return [
    "## Developer delegation brief (FR-014) — include ALL of this in `dev_delegate`",
    "",
    ...(cfg.tdd.required
      ? [
          "- **Test-driven development is mandatory.** Write the failing test FIRST, watch it",
          "  fail for the right reason, then implement until it passes. A test written after",
          "  the fix does not prove the fix.",
          `- Target ≥${cfg.tdd.targetCoverage}% line and branch coverage on every file the fix`,
          "  modifies. If coverage is below target, add targeted tests for the uncovered",
          "  branches before reporting done.",
        ]
      : ["- Add a regression test that fails without the fix and passes with it."]),
    "- **The plan's file list is a HARD scope constraint.** Tell the developer verbatim:",
    "  \"You may modify ONLY these files: [the plan's list]. If the fix requires modifying",
    "  any file not in this list, you MUST stop and report the justification for each",
    "  additional file rather than modifying it.\"",
    "- Then, at `converge`, verify that the actually-modified files are a SUBSET of the plan's list.",
    "  If they are not, call `self_heal_request_decision` with the extra files and their",
    "  justification — a scope violation is flagged for the user, never quietly accepted.",
    "- The mechanism never touches the Supervisor (`tools/supervisor/**`) or BOS's build",
    "  config (FR-023). If the fix needs either, call `self_heal_request_decision`.",
  ];
}

/** Class e: land the fix on `bos/self-heal-<caseId>` as a preview. */
function coreDelivery(record: HealingCase, featureBranch: string): string[] {
  return [
    "## Delivery — BOS core, on a feature branch",
    "",
    `The feature branch \`${featureBranch}\` is ALREADY the active feature branch on this`,
    "conversation. It was set server-side before your first token, so you must **never**",
    "call `dev_branch_request` — doing so would open an elicitation card that nothing",
    "will ever answer, and this run would hang until it times out. The git ref itself is",
    "created lazily by the first `dev_delegate`; that is expected.",
    "",
    "When `implement` is done and the preview is healthy (typecheck + build + health) and",
    `the test suite passes, call \`self_heal_complete_fix\` with caseId "${record.id}",`,
    `branch "${featureBranch}", and a one-paragraph summary of the fix. That emits the`,
    "`fix_ready` notification and closes out the case.",
    "",
    "You do NOT promote. Promotion is the user's explicit action (FR-024).",
  ];
}

/** Class d-bis: the user owns the item, so the fix ships as an `app_build`. */
function appDelivery(record: HealingCase): string[] {
  const appId = record.appId ?? "(the item id from the report)";
  return [
    "## Delivery — a user-owned marketplace item, via `app_build`",
    "",
    `This fix targets the user-owned item \`${appId}\` in \`data/user-apps/items/${appId}/\`.`,
    "It is NOT a BOS-source change: there is no feature branch and no Supervisor preview.",
    "",
    "Delegate the code change with `agent_delegate` + `contentOnly` into a fresh staging",
    "directory laid out as the item root, then call `app_build` with the item's EXISTING",
    `id (\`${appId}\`) so the installed item is updated rather than a second one created.`,
    "",
    `When the rebuilt item is installed and its tests pass, call \`self_heal_complete_fix\``,
    `with caseId "${record.id}" and appId "${appId}" plus a one-paragraph summary.`,
  ];
}

/** The full first-user-message for the autonomous BS conversation. */
export function buildAutonomousBrief(input: BriefInput): string {
  const { record, cfg, reportBody, featureBranch } = input;
  const branch = featureBranch ?? (record.scopeClass === "e" ? selfHealBranchFor(record.id) : undefined);
  return [
    `# Self-heal fix — case ${humanCaseId(record.id)}`,
    "",
    `A self-heal case has been diagnosed as scope class **${record.scopeClass}**`,
    `(${record.ownership}). Drive the Build Studio pipeline to a fix.`,
    "",
    ...preAuthorization(),
    "",
    ...commitBeforeAdvance(),
    "",
    "## Your input is a DIAGNOSTICS REPORT, not a spec (C3)",
    "",
    "The report below is **user intent**. Your method's FIRST authoring step must turn",
    "it into a proper specification — user stories, functional requirements, success",
    "criteria — not copy it in as if it were already one.",
    "",
    `Report on disk: \`${record.reportPath ?? "(see the case record)"}\``,
    "",
    "<diagnostics-report>",
    reportBody.trim(),
    "</diagnostics-report>",
    "",
    ...classificationVerification(record.proposedSurface ?? "(see the report)"),
    "",
    ...developerMandate(cfg),
    "",
    ...(record.scopeClass === "d-bis" ? appDelivery(record) : coreDelivery(record, branch ?? selfHealBranchFor(record.id))),
    "",
    "## Documentation (Constitution VI)",
    "",
    "If the fix changes how a feature behaves, update the relevant page under `docs/dev/`",
    "and `docs/usage/` in the same change — a fix that leaves the docs wrong is not done.",
  ].join("\n");
}

/** The resume message after the user answers a suspended decision (FR-016). */
/**
 * The brief for a FRESH run of a case the user stopped and restarted (FR-034,
 * scope-add ADR-13).
 *
 * Start deliberately does not resume the killed run in place — it relaunches
 * the role from the last committed artifact. That works because the pipeline
 * commits before it advances (FR-015), so the artifacts on disk are the resume
 * point; this brief's whole job is to say "re-read them, do not assume", the
 * same instruction the cold-restart recovery relies on.
 */
export function buildRestartBrief(record: HealingCase): string {
  return [
    `# Restart — self-heal case ${humanCaseId(record.id)}`,
    "",
    "Your previous run for this case was STOPPED (either by the user, or because it",
    "used its whole step budget without reporting a fix). Nothing that was already",
    "committed is lost.",
    "",
    "Start by re-reading the pipeline artifacts on disk to establish where the work",
    "actually got to — do not assume, and do not restart the pipeline from scratch if",
    "an artifact already exists. Then continue from there.",
    "",
    ...(record.stuckSignature && record.stuckSignature.tool
      ? [
          `The run was flagged as stuck: it called \`${record.stuckSignature.tool}\` ${record.stuckSignature.count} times`,
          "in a row with the same arguments and no progress. Do NOT repeat that call — if you",
          "need what it was looking for, get it a different way.",
          "",
        ]
      : []),
    ...(record.activeFeatureBranch ? [`Feature branch: \`${record.activeFeatureBranch}\``, ""] : []),
    "The pre-authorization still stands: run autonomously to completion, and stop only",
    "via `self_heal_request_decision` if something genuinely cannot be decided without",
    "the user.",
  ].join("\n");
}

export function buildResumeBrief(record: HealingCase, answer: string): string {
  return [
    `# Resume — self-heal case ${humanCaseId(record.id)}`,
    "",
    "The question you suspended on has been answered by the user:",
    "",
    "**Question**",
    "",
    `> ${(record.pendingQuestion ?? "(question not recorded)").replace(/\n/g, "\n> ")}`,
    "",
    "**Answer**",
    "",
    `> ${answer.replace(/\n/g, "\n> ")}`,
    "",
    "Write that answer into the current pipeline artifact FIRST (commit-before-advance,",
    "FR-015), then continue the pipeline from wherever the artifacts on disk say you got",
    "to. Re-read them rather than assuming — this is a fresh run.",
    "",
    "The pre-authorization still stands: run autonomously to completion, and stop again",
    "only via `self_heal_request_decision` if something else genuinely cannot be decided.",
  ].join("\n");
}
