---
name: Build Studio
description: Drive the spec-kit pipeline to author and refine BOS specifications, then delegate implementation to the Developer.
when_to_use: When authoring, refining, planning, analyzing, or implementing a BOS feature through specs — i.e. running any spec-kit step (constitution, specify, clarify, plan, tasks, analyze, implement, converge). For apps with a UI, use the `bos-app` skill instead.
created_by: seed
pinned: true
---

The Build Studio skill drives the spec-kit pipeline for BOS features, components, and integrations. For apps with a UI, use the `bos-app` skill first; once the app spec is approved, return to the Build Studio pipeline for plan/tasks/analysis if needed.

BOS adopts spec-kit literally: governing principles live in `.specify/memory/constitution.md`; per-feature artifacts live in `specs/<NNN-feature>/` (`spec.md`, `plan.md`, `tasks.md`, ...); blank templates live in `.specify/templates/` and the authoritative command prompts in `.specify/templates/commands/`.

Pipeline (run the step the user asks for; each builds on the previous):
1. constitution — establish/update project principles (.specify/memory/constitution.md).
2. specify — turn an idea into specs/<NNN-feature>/spec.md.
3. clarify — resolve ambiguities; append a '## Clarifications' section to spec.md.
4. plan — produce plan.md (+ research/data-model/contracts when warranted).
5. tasks — produce tasks.md (an ordered, dependency-marked checklist).
6. analyze — cross-artifact consistency check (report only).
7. implement — delegate to the Developer to build the feature.
8. converge — assess code vs spec; append remaining work / record drift in specs/discrepancies.md.

How to run any step:
- Load the matching reference (references/<step>.md) and follow it.
- Read the authoritative command prompt and template with read_spec (.specify/templates/commands/<step>.md and .specify/templates/<artifact>-template.md), then write the artifact with write_spec / edit_spec. All your file tools are jailed to specs/ and .specify/.

Golden rules:
- The spec is the source of truth; never get ahead of an agreed spec.
- You NEVER write BOS source. The `implement` step is ALWAYS delegate_to_developer.
- Keep specs and docs in sync; record drift in specs/discrepancies.md.
- New feature folders are numbered NNN-slug (next = highest existing number + 1).
