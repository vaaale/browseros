import type { AppManifest } from "@/os/types";

const manifest: AppManifest = {
  id: "build-studio",
  name: "Build Studio",
  icon: "Hammer",
  defaultWidth: 1320,
  defaultHeight: 720,
  order: 55,
  singleton: true,
  builtin: true,
  // 035-spec-promote-conflict-escalation (FR-007): Build Studio is where a git
  // conflict gets resolved, so it declares the handler for the escalation
  // event. The Event Viewer resolves a clicked event through this; the
  // AUTO-launch (the user takes no action) is the topbar subscriber in
  // src/components/desktop/ConflictLaunch.tsx.
  eventHandlers: [
    {
      id: "conflict-escalated",
      type: "com.bos.gitops.conflict.escalated",
      displayName: "Open conflict resolution",
      description: "Launch the Build Studio conflict-resolution pane for this session",
      icon: "GitMerge",
    },
    // 031-self-healing (FR-017/FR-022): Build Studio is where a Healing Case is
    // reviewed, so it declares the handlers for the two self-heal events a user
    // is expected to ACT on. Clicking either in the Event Viewer opens the
    // Self-Heal pane on that case — the payload's `caseId` becomes the launch
    // param the pane deep-links from.
    {
      id: "self-heal-fix-ready",
      type: "com.bos.self-heal.fix_ready",
      displayName: "Review the self-heal fix",
      description: "Open the Build Studio Self-Heal page on this case's finished fix",
      icon: "HeartPulse",
    },
    {
      id: "self-heal-decision-needed",
      type: "com.bos.self-heal.decision_needed",
      displayName: "Answer the self-heal question",
      description: "Open the Build Studio Self-Heal page on the suspended case waiting for your decision",
      icon: "HeartPulse",
    },
    // 031-self-healing scope-add (FR-026/FR-034): the three run-lifecycle
    // events. `run_stuck` is the one that genuinely needs a human — a run
    // looping with no progress will keep burning the budget until someone
    // stops it — and all three land the user on the case, where the transcript
    // and the Stop/Start controls are.
    {
      id: "self-heal-run-stuck",
      type: "com.bos.self-heal.run_stuck",
      displayName: "Look at the stuck self-heal run",
      description: "Open the Build Studio Self-Heal page on the case whose run appears stuck",
      icon: "HeartPulse",
    },
    {
      id: "self-heal-run-aborted",
      type: "com.bos.self-heal.run_aborted",
      displayName: "Open the stopped self-heal case",
      description: "Open the Build Studio Self-Heal page on the case whose run was stopped",
      icon: "HeartPulse",
    },
    {
      id: "self-heal-run-restarted",
      type: "com.bos.self-heal.run_restarted",
      displayName: "Open the restarted self-heal case",
      description: "Open the Build Studio Self-Heal page on the case whose run was restarted",
      icon: "HeartPulse",
    },
    // 031-self-healing (FR-038): the branch-settled notices. The toast text is
    // the event's own summary ("EHS-<id> resolved — fix promoted — <title>");
    // clicking either lands on the closed case for the record.
    {
      id: "self-heal-fix-promoted",
      type: "com.bos.self-heal.fix_promoted",
      displayName: "Open the resolved self-heal case",
      description: "Open the Build Studio Self-Heal page on the case whose fix you promoted",
      icon: "HeartPulse",
    },
    {
      id: "self-heal-fix-discarded",
      type: "com.bos.self-heal.fix_discarded",
      displayName: "Open the dismissed self-heal case",
      description: "Open the Build Studio Self-Heal page on the case whose fix you discarded",
      icon: "HeartPulse",
    },
    // 031-self-healing scope-add (FR-036): the discard notice. The case record
    // is GONE by the time this event exists, so the handler lands on the pane's
    // list rather than pretending the case can still be opened.
    {
      id: "self-heal-case-discarded",
      type: "com.bos.self-heal.case_discarded",
      displayName: "Self-heal case discarded",
      description: "Open the Build Studio Self-Heal page — the discarded case's record was deleted",
      icon: "HeartPulse",
    },
  ],
  // These events are emitted by the gitops pipeline and the self-heal spine,
  // not by Build Studio, so they fall outside BS's own `com.bos.build-studio.*`
  // root. Kept as advisory documentation of what BS listens to — since 037 no
  // grant is required.
  eventNamespaces: ["com.bos.gitops.*", "com.bos.self-heal.*"],
};

export default manifest;
