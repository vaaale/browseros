# BrowserOS — Specifications Overview

BrowserOS (BOS) is a single-page, server-side-rendered "operating system in the browser"
(Next.js App Router + React + Zustand + CopilotKit) with an agentic assistant that can
operate and **modify BOS itself**.

Specifications follow **GitHub spec-kit**. Governing principles live in the **constitution**
(`.specify/memory/constitution.md`); each feature has its own folder under
`specs/<NNN-feature>/`. This file is the slim map that replaces the legacy `spec/bos.md`
overview — its principles moved to the constitution and its foundational requirements moved
to `000-browseros-core`.

## Feature map

| #   | Feature | Spec |
|-----|---------|------|
| 000 | BrowserOS Core (shell, assistant, configuration) | `specs/000-browseros-core/` |
| 001 | Build Studio (spec-kit authoring) | `specs/001-build-studio/` |
| 002 | Memory system | `specs/002-memory/` |
| 003 | Self-improvement (learning loop & skills) | `specs/003-self-improvement/` |
| 004 | Browser automation | `specs/004-browser-automation/` |
| 005 | Self-modification (live version control) | `specs/005-self-modification/` |
| 006 | Data isolation (DataFS) | `specs/006-data-isolation/` |
| 007 | GitFS (versioned content) | `specs/007-gitfs/` |
| 008 | Self-testing (Playwright) | `specs/008-self-testing/` |
| 009 | Installed apps | `specs/009-installed-apps/` |
| 010 | Documentation hub | `specs/010-documentation/` |
| 011 | Per-agent capabilities (tools/skills/MCP) — *Draft* | `specs/011-per-agent-capabilities/` |
| 012 | Embeddable Assistant (integration plane) — *Draft* | `specs/012-embeddable-assistant/` |
| 013 | Build Studio — agentic studio (idea → built feature) — *Draft* | `specs/013-build-studio-agentic/` |

## Other artifacts

- `.specify/memory/constitution.md` — the project constitution (governing principles).
- `specs/discrepancies.md` — where code currently diverges from these specs.
- `.specify/templates/` — spec-kit templates; `.specify/templates/commands/` — the pipeline command prompts (the basis for Build Studio's skill).

New features are authored through **Build Studio** (`001-build-studio`), which drives the
spec-kit pipeline and delegates implementation to the Developer.
