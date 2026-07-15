---
name: feature-wizard
description: Proactive end-to-end guide that drives the user through building a BOS feature. Requirements → UI Design → Spec → Branch → Plan → Implementation → Tests → Promote/Discard.
when_to_use: When the user wants to build a new feature from scratch and needs guided support through the full lifecycle, or when they say "I want to build X" without an existing spec.
created_by: seed
pinned: true
---

Feature Wizard drives the FULL feature lifecycle. Work through each phase in order; never skip ahead without satisfying the gate. Load the reference for each phase before executing it.

═══════════════════════════════
PHASE 0 — REQUIREMENTS
═══════════════════════════════
Open with: "Tell me about the feature you'd like to build — what problem does it solve, and who uses it?"
Iterate until you can clearly state:
  • Problem statement
  • User stories (who does what, what outcome do they get)
  • Interaction model (UI, system behavior, or agent capability?)
  • Success criteria (measurable)
  • Out-of-scope items
  • Constitution fit — read bos-system-specs/.specify/memory/constitution.md; flag any conflicts
GATE: Summarise requirements back to the user. Proceed only when they confirm.

═══════════════════════════════
PHASE 1 — UI DESIGN (skip if no UI)
═══════════════════════════════
See references/ui-design.md.
GATE: User approves the UI design.

═══════════════════════════════
PHASE 2 — SPECIFICATION
═══════════════════════════════
1. Find the next feature ID: spec_list on user-specs; next NNN = max existing + 1.
2. Read commands/specify.md and spec-template.md with spec_template_read.
3. Write user-specs/<NNN-slug>/spec.md following the template.
   Feature Branch field: use `<NNN-slug>` (without bos/ prefix — the wizard adds it in Phase 3).
   Include a summary of the approved UI design if one was produced.
4. buildstudio_artifact_open('user-specs/<NNN-slug>/spec.md') + buildstudio_tree_refresh().
5. Say: "Here is the full specification — please review it. Anything to change?"
6. Edit with spec_edit until the user explicitly approves.
GATE: User approves the spec.

═══════════════════════════════
PHASE 3 — FEATURE BRANCH
═══════════════════════════════
See references/branch-setup.md.
GATE: Feature branch is active on this conversation (dev_branch_request returned success).

═══════════════════════════════
PHASE 4 — PLAN & TASKS
═══════════════════════════════
1. Read commands/plan.md and plan-template.md with spec_template_read.
2. Write user-specs/<id>/plan.md:
   - Constitution check (quote the relevant principles and confirm compliance)
   - Technical context: which BOS files/systems are involved?
   - Real proposed file paths (not placeholders)
   - Design notes and trade-offs
3. Read commands/tasks.md and tasks-template.md with spec_template_read.
4. Write user-specs/<id>/tasks.md: T001, T002 … grouped by user story, dependency-ordered, [P] for parallelisable.
5. Open both artifacts and refresh the tree.
6. Say: "Here is the plan and task list. Review carefully — once you approve, I hand it to the Developer."
GATE: User explicitly approves BOTH plan and tasks before delegation.

═══════════════════════════════
PHASE 5 — IMPLEMENTATION
═══════════════════════════════
Call dev_delegate with a COMPLETE brief (the Developer has no other context):
  "Read the spec at specs/user-specs/<id>/ — spec.md, plan.md, tasks.md.
   <Paste a concise summary of the spec and plan here.>
   Tasks to execute: <list from tasks.md>.
   Acceptance criteria: <from spec.md>.
   Constraints:
   - Keep all changes on the active feature branch
   - Run npx tsc --noEmit and npm run lint; fix every error before finishing
   - Update relevant docs under docs/ if architecture changed
   - Name any Playwright test file e2e/<feature-id>.spec.ts"
After dev_delegate returns, summarise what was built and call buildstudio_tree_refresh().

═══════════════════════════════
PHASE 6 — TESTING
═══════════════════════════════
See references/testing.md.
GATE: All tests pass.

═══════════════════════════════
PHASE 7 — PROMOTE / DISCARD
═══════════════════════════════
Say: "The feature is implemented and all tests pass.
To ship it:
  • Promote the spec: click the Promote button in the Build Studio spec tree (left pane).
  • Promote the code: in the topbar Active menu, promote the feature branch to main.
To abandon it:
  • Click Discard in the spec tree to remove spec changes.
  • Delete the feature branch from the Active menu."
Do NOT merge or delete branches yourself — the user controls Promote/Discard.

═══════════════════════════════
HARD RULES
═══════════════════════════════
- Never skip a gate. If the user wants to rush, remind them what they're skipping.
- Never write BOS source code yourself. Implementation = dev_delegate only.
- If something is truly unclear, ask. Do not assume.
- Keep spec.md as the source of truth; update it if anything changes during implementation.
