---
name: Build Studio
description: Drive the spec-kit pipeline to author and refine BOS specifications, then delegate implementation to the Developer.
when_to_use: When authoring, refining, planning, analyzing, or implementing a BOS feature through specs — i.e. running any spec-kit step (constitution, specify, clarify, plan, tasks, analyze, implement, converge). For apps with a UI, use the `bos-app` skill instead.
created_by: seed
pinned: true
---

The Build Studio skill drives the spec-kit pipeline for BOS features, components, and integrations. For apps with a UI, use the `bos-app` skill first; once the app spec is approved, return to the Build Studio pipeline for plan/tasks/analysis if needed.

BOS adopts spec-kit literally: specs live under the VFS mount `/Specs/` — a BOS-owned system store at `/Specs/bos-system-specs/` and your writable store at `/Specs/user-specs/`; list either with `file_list`. Governing principles live in the system store at `/Specs/bos-system-specs/.specify/memory/constitution.md`; per-feature artifacts live in `/Specs/<store>/<NNN-feature>/` (`spec.md`, `plan.md`, `tasks.md`, ...). Blank templates and the authoritative command prompts are mounted read-only at `/Templates/` (e.g. `/Templates/spec-template.md`, `/Templates/commands/specify.md`).

Pipeline (run the step the user asks for; each builds on the previous):
1. constitution — establish/update project principles (`/Specs/bos-system-specs/.specify/memory/constitution.md`).
2. specify — turn an idea into `/Specs/user-specs/<NNN-feature>/spec.md`.
3. clarify — resolve ambiguities; append a '## Clarifications' section to spec.md.
4. plan — produce plan.md (+ research/data-model/contracts when warranted).
5. tasks — produce tasks.md (an ordered, dependency-marked checklist).
6. analyze — cross-artifact consistency check (report only).
7. implement — delegate to the Developer to build the feature.
8. converge — assess code vs spec; append remaining work / record drift in `/Specs/bos-system-specs/discrepancies.md`.

How to run any step:
- Load the matching reference (references/<step>.md) and follow it.
- Read the authoritative command prompt and template with `file_read` under `/Templates/` (e.g. `/Templates/commands/<step>.md` and `/Templates/<artifact>-template.md`), then author the artifact under `/Specs/<store>/...`. Use `file_write` ONLY to create a new artifact (or an intentional full rewrite); to MODIFY an existing artifact — adding a section, updating requirements, appending clarifications — read it first, then make targeted changes with `file_edit` (one change) or `file_patch` (several ordered find/replace hunks in one atomic call). Never rewrite a whole file just to add or tweak content. Your file tools reach the spec stores and docs (never BOS source itself).

Golden rules:
- The spec is the source of truth; never get ahead of an agreed spec.
- You NEVER write BOS source. The `implement` step is ALWAYS `dev_delegate`.
- New specs you author go in `/Specs/user-specs/`. Writes require an active feature branch (call `dev_branch_request` first if none is set) and land on that branch's worktree, promoted/discarded together with the code; changing the constitution needs extra care.
- Keep specs and docs in sync; record drift in `/Specs/bos-system-specs/discrepancies.md`.
- New feature folders are numbered NNN-slug (next = highest existing number + 1 within the store).
