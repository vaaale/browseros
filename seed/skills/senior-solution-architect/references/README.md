# senior-solution-architect

BOS's own architecture skill — used by the `architect` agent (and directly by Build Studio) to classify a new app/feature/service against BOS's real implementation shapes and design it at the right level of C4/ADR ceremony, grounded in BOS's actual subsystems (not generic system design).

Note: this skill was originally a generic, project-agnostic architecture skill (see the eval fixtures below, which still reflect that generic origin — ride-sharing/e-commerce examples, not BOS). `SKILL.md` itself has since been rewritten to be BOS-specific; the eval fixtures were intentionally left as-is (they test a different, generic-skill-testing harness, not the architect agent's actual behavior) — treat them as historical, not as a description of current scope.

## When to use

- Designing a new BOS app, feature, or service (classification — bos-core / builtin-app / marketplace-item — comes first, before any diagram; a marketplace item's app and service facets are designed together, not as separate targets).
- Reviewing whether an existing or proposed design actually fits BOS's architecture.
- Formalizing a non-obvious technical decision as an ADR.
- Producing a C4-level (Context/Container/Component) description of a BOS subsystem or feature, using BOS's real containers (Next.js app, Supervisor/previews, worker-thread services, marketplace item repos, VFS/GitFS, Bastion).

## What is included

- `SKILL.md` — the BOS-grounded architecture workflow (classify → design → ADRs → implementation guidance)
- `evals/evals.json`, `evals/trigger-eval.json` — generic-skill test fixtures predating the BOS-specific rewrite (see note above)

## Typical invocation

- "Design the architecture for a WebDAV VFS-mount feature."
- "Should this be a built-in app or a marketplace app?"
- "Write an ADR for choosing a worker-thread service over a new API route here."
- "Review this feature's architecture before we write plan.md."

## What's New in v2.0

- **Progress Tracking** — 4-phase gauge bar (Context Discovery → Architecture Analysis → C4 Modeling / ADR Writing → Design Review) displayed during execution
- **EVals** — `evals/evals.json` with 3 realistic test cases; `evals/trigger-eval.json` with 20 queries (10 trigger / 10 no-trigger) for description optimization
- **Standardized description** — SKILL.md description updated to Anthropic skill-creator format

---

## Metadata

| Field | Value |
|-------|-------|
| Version | 2.1.0 |
| Author | Eric Andrade |
| Created | 2026-03-01 |
| Updated | 2026-03-19 |
| Platforms | GitHub Copilot CLI, Claude Code, OpenAI Codex, OpenCode, Gemini CLI, Antigravity, Cursor IDE, AdaL CLI |
| Category | architecture |
| Tags | architecture, c4-model, adr, systems-design, clean-architecture |
| Risk | safe |
