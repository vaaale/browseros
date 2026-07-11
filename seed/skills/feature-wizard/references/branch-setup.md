Phase 3 — Feature Branch Setup.

The spec.md Feature Branch field holds the bare branch slug (e.g. "001-my-feature", no bos/ prefix).

Steps:
1. Read the Feature Branch field from the spec you just wrote (spec_read 'user-specs/<id>/spec.md').
2. Call dev_branch_request with:
     task: "<feature name> — BOS feature branch for implementation"
     suggestedBranch: "<value from spec's Feature Branch field>"
   The elicitation card will pre-fill the input with the suggested name (normalised to bos/<slug>).
   The user confirms or edits the name, then the branch is created and activated on this conversation.
3. If the user changed the branch name, update the Feature Branch field in spec.md with spec_edit to keep them in sync.

Only proceed to Phase 4 (Plan & Tasks) after dev_branch_request returns a success message confirming the branch is active.
