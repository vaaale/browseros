Phase 2 — Feature Branch Setup.

This runs BEFORE the spec is written (Phase 3): `user-specs` (where the spec is about to
land) is writable only on a real feature branch, and it's the SAME `bos/*` branch this
feature's eventual implementation lands on — one branch for both, set up once, here.

Steps:
1. From the requirements gathered in Phase 0, derive a short kebab-case slug for the
   feature (e.g. "voice-command-palette").
2. Call dev_branch_request with:
     task: "<feature name> — feature branch for its spec and implementation"
     suggestedBranch: "<the slug>"
   The elicitation card will pre-fill the input with the suggested name (normalised to bos/<slug>).
   The user confirms or edits the name, then the branch is created and activated on this conversation.
3. Remember the confirmed branch name — it goes in the spec's Feature Branch field in Phase 3.

Only proceed to Phase 3 (Specification) after dev_branch_request returns a success message
confirming the branch is active.
