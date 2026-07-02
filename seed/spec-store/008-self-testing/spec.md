# Feature Specification: Self-Testing (Playwright Verify Stage)

**Feature Branch**: `008-self-testing`

**Created**: 2026-06-28 (migrated from `spec/self-modification/testing.md`)

**Status**: Implemented

**Input**: "A candidate version tests itself end-to-end with Playwright before the user promotes it: a verify stage on the self-modification gate, agent-authored tests and fixtures, probe-and-degrade, a configurable promote gate with override, and result reporting."

> Migrated from `spec/self-modification/testing.md`. Companion to `005-self-modification` (the control plane); authoritative for how a candidate is functionally verified.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A candidate is functionally verified before I promote (Priority: P1)

A Playwright verify stage runs after the candidate is healthy; it reaches `verified` or `tests-failed`.

**Acceptance Scenarios**:

1. **Given** a `ready` candidate, **When** the verify stage runs, **Then** the Supervisor runs the Playwright suite against the candidate's port and records `verified` or `tests-failed`.

### User Story 2 - The agent writes the tests as part of the change (Priority: P1)

The Developer authors deterministic Playwright tests + fixtures for each change and runs them green; a change without tests is incomplete.

**Acceptance Scenarios**:

1. **Given** a feature change, **When** the Developer completes it, **Then** accompanying Playwright tests and fixtures exist and pass.

### User Story 3 - A missing browser never blocks self-modification (Priority: P1)

Probe-and-degrade skips the e2e stage with a clear status when no browser is available.

### User Story 4 - I keep the option to ship (Priority: P2)

A configurable gate (`block-with-override` default | `advisory`) governs promotion of a failing candidate; the override action is always available.

### Edge Cases

- Chat/assistant flows hit a slow, nondeterministic model — tests MUST stub the LLM and assert only deterministic UI.
- Driving a real browser via code execution requires a sandboxed environment (already assumed for the dev harness).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The validation gate MUST gain a verify stage after health: `building→ready (boot+health)→testing (Playwright)→verified | tests-failed`; `ready` is previewable (preview is NOT blocked on verify); the Supervisor orchestrates the run against the candidate's port.
- **FR-002**: A startup/on-demand probe MUST detect whether a usable browser is available; if not, the verify stage is SKIPPED with a clear surfaced status (verified-by-fallback on build+health). Self-testing is an enhancement, never a hard requirement.
- **FR-003**: The Developer MUST author Playwright tests covering each change and generate the required fixtures, and run them green before reporting done (encoded in the dev agent prompt + the develop skills); tests MUST be self-contained, deterministic, and non-destructive.
- **FR-004**: A versioned baseline suite of OS golden paths MUST live in `e2e/` targeting stable hooks (`data-testid="desktop" | "dock" | "dock-<appId>" | "window-<appId>"`), with a global setup that writes the `setupComplete` flag; the agent extends it. It especially guards against SSR/hydration mismatches.
- **FR-005**: Chat/assistant flows MUST stub the LLM and assert deterministic UI (message sent / streaming appears), never model output; the promote gate MUST NOT depend on nondeterministic output.
- **FR-006**: A configurable `gatePolicy` (`block-with-override` default | `advisory`) MUST govern promotion of a `tests-failed` candidate; the override action is ALWAYS available (the policy governs only whether a warning step precedes it); a degraded/skipped verify stage never blocks promote.
- **FR-007**: The Developer SHOULD drive a live browser against the running candidate via shell/code execution (Claude CLI uses its own Bash; local sub-agents get a sandboxed code/shell-exec tool; Playwright MCP is a fallback for self-testing only), emitting screenshots/observations and reading them back; runs sandboxed.
- **FR-008**: The Supervisor MUST capture per-candidate artifacts (pass/fail counts, HTML report, traces, failing-step screenshots/video); a concise result MUST be surfaced in chat on completion and in the Versions view, retained per candidate (retention setting) and discarded with the candidate.
- **FR-009**: A config namespace (part of/alongside `self-modification`) MUST expose `mode` (`auto` | `off`), `gatePolicy`, the browser/capability read-out, and report retention.

### Key Entities

- **Verify stage** — the Playwright gate step (testing→verified/tests-failed).
- **Baseline e2e suite** — versioned OS golden-path tests in `e2e/`.
- **Browser capability probe** — shared "is a browser available?" check.
- **Gate policy** — block-with-override | advisory.
- **Candidate test report** — per-candidate artifacts.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A candidate runs its e2e suite before it can be promoted without override.
- **SC-002**: With no browser available, the e2e stage is skipped and self-modification still works.
- **SC-003**: The user can always override a failing gate and ship.
- **SC-004**: Chat-flow tests never assert on model output.

## Notes

- Extends the `005-self-modification` gate; the isolated clone from `006-data-isolation` makes self-testing non-destructive. Shares the Playwright substrate with `004-browser-automation` (MCP is primary there, a fallback here). "A change without tests is incomplete" is part of the development workflow (`003-self-improvement`).
- Faithful migration of `spec/self-modification/testing.md`; original prose remains in git history.
