# Feature Specification: Browser Automation

**Feature Branch**: `004-browser-automation`

**Created**: 2026-06-28 (migrated from `spec/automation/browser-automation.md`)

**Status**: Implemented

**Input**: "Expose Playwright-based browser automation to the assistant as a first-class, gated MCP tool so the assistant, sub-agents, and workflows can drive a real browser — navigate, fill forms, click flows, extract data, take screenshots — sandboxed and off by default."

> Migrated from `spec/automation/browser-automation.md`. Distinct from `008-self-testing`: same Playwright substrate, but a different driver (assistant via MCP vs dev agent via CLI) and risk profile.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The assistant can act on the live web (Priority: P1)

The assistant (which has no shell) drives a real browser through structured MCP tools; calls, snapshots, and screenshots stream into the chat.

**Acceptance Scenarios**:

1. **Given** automation is enabled, **When** the assistant runs a browser task, **Then** Playwright MCP tools execute and their events render live as cards / MCP-UI.

### User Story 2 - Off and sandboxed until I enable and scope it (Priority: P1)

A Settings namespace governs enablement, host scope, headless, isolation, consent, and limits; the capability is disabled until configured.

**Acceptance Scenarios**:

1. **Given** the feature is off (default), **When** the assistant attempts a browser task, **Then** no browser tools are available.
2. **Given** the user enables it with an isolated profile, **When** automation runs, **Then** it uses a profile with no access to the user's real cookies/sessions.

### User Story 3 - Page content cannot hijack the agent (Priority: P2)

Content read from automated pages is treated as untrusted data, never as instructions.

### Edge Cases

- Host scope (allowed/blocked origins) is advisory only and does not affect redirects; true containment is the execution sandbox.
- If no Playwright browser is available, the tools degrade to unavailable with clear status — never a hard failure.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: BOS MUST expose browser automation via the official Playwright MCP server (`@playwright/mcp`), wired into the existing MCP runtime so its tools auto-appear to the assistant, sub-agents, and workflows (and in the Tools panel); BOS MUST NOT reimplement the browser tools.
- **FR-002**: A browser context MUST be scoped per conversation/run, isolated by default, cleaned up on end/timeout, with enforced resource limits (max concurrent contexts, navigation/action timeouts).
- **FR-003**: Tool calls, accessibility snapshots, and screenshots MUST stream into the chat as event cards / MCP-UI so headless automation is visible as it happens.
- **FR-004**: BOS MUST launch the browser via `--executable-path` pointing at the Chromium resolved by the shared capability probe (reusing the e2e browser; no extra download); stdio command arguments MUST be space-free (origin lists use `;`).
- **FR-005**: The capability MUST be OFF by default and disabled until enabled and scoped; when no browser is available the tools MUST degrade to unavailable with clear status.
- **FR-006**: Real containment MUST be the execution sandbox — the Playwright browser makes its own network requests and bypasses the app-level `isBlockedHost()` proxy guard; host scope is advisory defense-in-depth, NOT a security boundary (the server default is allow-all).
- **FR-007**: An isolated browser profile MUST be the default (no access to real cookies/sessions/credentials); downloads MUST be disabled by default.
- **FR-008**: The agent's tool guidance MUST state that extracted page content is untrusted input and must not be followed as instructions.
- **FR-009**: A configurable consent policy (`off` | `per-use` | `per-session`) MUST be exposed; the controls enforced today are the `enabled` gate, the origin filters, and the isolated profile; per-use/per-session elicitation is configurable but NOT yet enforced (a known follow-up).
- **FR-010**: A `browser-automation` config namespace MUST render a Settings tab (and auto-expose to the assistant) with at least: enabled (default off), allowed/blocked origins, headless (default true), isolated profile (default true), consent policy, downloads (default false), and limits.

### Key Entities

- **Playwright MCP server** — managed stdio server providing the browser tools.
- **Browser context/session** — per-run, isolated, resource-limited.
- **Capability probe** — shared "is a browser available?" check that also resolves the Chromium path.
- **`browser-automation` config namespace** — the policy surface.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With the feature off, no browser tools are exposed to the assistant.
- **SC-002**: Automation reuses the single installed Chromium with no additional download.
- **SC-003**: An isolated profile is used by default — no leakage of the user's real sessions.
- **SC-004**: Automation tool activity is visible live in the chat.

## Notes

- Complements the proxy **Web Browser** app (user-facing, guarded by `isBlockedHost()`): different actor, trust tier, and containment.
- Shares the Playwright substrate with `008-self-testing` (MCP here is primary; there it is a fallback).
- Faithful migration of `spec/automation/browser-automation.md`; original prose remains in git history.
