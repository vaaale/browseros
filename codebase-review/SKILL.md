---
name: codebase-review
description: Conduct a principal-engineer-level review of an entire codebase (or a large subsystem) and produce a severity-categorized report covering architecture, security, duplication, concurrency, correctness, tests, and code health. Use this whenever the user asks for a "code review", "architecture review", "tech-debt audit", "review the project/repo", "look for architectural improvements", "find duplicated code", "assess code quality", "what should we refactor", or hands over a folder and asks what's wrong with it — even if they don't use the exact phrase "code review". Prefer this over ad-hoc reading when the scope is a whole repo or a subsystem too big to hold in one pass. Not for reviewing a single small PR/diff (use a diff-focused review for that) or for writing new features.
---

# Codebase Review

Produce the kind of review a principal engineer gives after reading a whole codebase: findings that are **specific** (file + line + quoted evidence), **verified** (read the code, don't infer), **categorized by severity**, and **actionable** (each has a concrete fix). The deliverable is a single Markdown report the user can act on.

The core problem with whole-repo review is that no single pass can hold the whole system in context. The strategy is to **partition the codebase into domains, review them in parallel, run mechanical checks alongside, verify the sharpest claims yourself, then synthesize** into one categorized report. This scales to large repos and surfaces cross-cutting patterns (the same missing helper causing bugs in ten files) that a linear file-by-file read misses.

## Workflow

### 1. Orient and scope

Before partitioning, get the lay of the land cheaply:

- Read any `CLAUDE.md`, `README`, `ARCHITECTURE`, or `docs/` overview — these tell you the intended design, the trust model, and the invariants. Findings are only meaningful relative to what the code is *supposed* to do (e.g. "server-only code must live behind API routes", "this input is untrusted").
- Get a file/LOC map: `find src -type f \( -name '*.ts' -o -name '*.tsx' \) | xargs wc -l | sort -rn | head -30` (adapt the extensions). The largest files are usually where the debt concentrates — prioritize them.
- List top-level directories to identify natural domain boundaries.

If the user hasn't said what they care about most (security? maintainability? a specific subsystem?) and the scope is ambiguous, ask one clarifying question. Otherwise proceed — a broad review is a fine default.

### 2. Partition into domains and review in parallel

Split the codebase into 4-6 **coherent domains** along architectural seams, not arbitrary file counts. Typical seams: core/state, the server/API boundary, a security-sensitive subsystem, the UI/presentation layer, infrastructure/shared libs, the data layer. Make the partition cover everything with minimal overlap.

If subagents are available, spawn **one review agent per domain in a single turn** so they run concurrently. Each agent gets the domain-review prompt below. If subagents are not available (e.g. Claude.ai), do the domains sequentially yourself, holding findings until synthesis — same structure, less parallelism.

Give each domain agent this prompt (fill in the bracketed parts):

```
You are doing a principal-engineer code review of part of [PROJECT] at [ABSOLUTE PATH].
READ-ONLY: do not modify any files.

Your scope: [explicit list of directories/globs]. Out of scope: [what other agents cover].

Context: [1-3 sentences on the intended architecture and trust model, drawn from step 1 —
e.g. "this is the server boundary; all fs/secrets code lives here; installed apps call these
routes same-origin, so treat route inputs as untrusted".]

Review for: architectural problems (layering violations, client/server boundary leaks, god
modules, tight coupling, bad module boundaries), duplicated code (QUANTIFY it — how many files
repeat the pattern), security issues (path traversal, injection, SSRF, missing input validation,
secret exposure, missing authz), concurrency/data-integrity issues (unlocked read-modify-write,
races, TOCTOU), error-handling gaps (swallowed errors, unchecked responses, unhandled rejections),
type-safety issues (unsafe casts, any), dead code, and maintainability (oversized files/functions,
magic values).

Read the actual code thoroughly — prioritize the largest files. For EACH finding report:
severity (Critical/High/Medium/Low), file path + line numbers, a one-paragraph explanation with
a brief quoted snippet as evidence, and a concrete suggested fix. Only report what you VERIFIED
in the code — no speculation. Where a bug and its root cause recur, say how many times.
End with a 2-3 sentence assessment of this area's overall health.
```

### 3. Run mechanical checks alongside

In parallel with the domain agents, run the checks the language/stack supports. These catch what reading misses and let you quantify claims:

- **Duplication scan**: `npx jscpd <src> --min-tokens 70 --reporters consoleFull` (JS/TS), or the equivalent for the stack. Note in the report that token-based clone detection *under-counts structural/idiomatic duplication* (same shape, different identifiers) — quantify that kind directly from the domain findings instead of relying on the tool's percentage.
- **Type check / compile**: `tsc --noEmit`, `mypy`, `go vet`, `cargo check`, etc.
- **Lint**: the project's configured linter.
- **Test inventory**: count unit/integration/e2e tests and gauge coverage of the risky areas. Missing tests around the exact code paths flagged as risky (concurrency, path-jailing) is itself a finding.
- **Dependency freshness**: scan for outdated or unmaintained deps if relevant.

### 4. Verify the sharpest claims yourself

Do not ship a Critical or High finding on a subagent's word alone. For each of the top findings, open the cited file yourself and confirm the line, the data flow (is the dangerous input actually reachable/untrusted?), and that the fix makes sense. Downgrade or drop anything you can't confirm. If independent domain agents converged on the same issue, note that — it raises confidence. Being wrong about a "Critical" is worse than missing a Medium.

### 5. Synthesize the report

Write one Markdown file (default `CODE_REVIEW.md` in the repo root, or where the user wants it). Deduplicate overlapping findings from different agents, merge them under shared root causes, and order by severity. Use the structure in the next section. Then present the file to the user and give a tight spoken summary (headline + counts + the 2-3 things that matter most). Offer to implement the top fixes on a branch.

## Report structure

Use this template. Adapt category names to what the codebase actually surfaces — don't invent empty sections.

```markdown
# [Project] — Code Review

**Date:** [date]  **Scope:** [what was reviewed: file/LOC counts, domains, checks run]

## Executive summary
[2-4 short paragraphs. What's genuinely healthy (be specific and fair — reviews that are all
negative aren't trusted). Then the 1-3 SEAMS where problems concentrate, framed as patterns with
root causes, not a flat list. Note any caveat about the mechanical scan under-counting.]

### Findings by severity
| Severity | Count | Theme |
|---|---|---|
| Critical | n | ... |
| High | n | ... |
| Medium | n | ... |
| Low | n | ... |

### Top N remediation priorities
[Ranked by (Impact + Risk) × ease. The one-line-guard security fixes and the shared-helper
refactors that fix many bugs at once usually rank highest.]

## Category 1 — [Architecture]
## Category 2 — [Security]
## Category 3 — [Concurrency & data integrity]
## Category 4 — [Duplication / code]
## Category 5 — [Correctness & error handling]
## Category 6 — [Type safety]
## Category 7 — [Tests]
## Category 8 — [Docs & consistency]
## Category 9 — [Performance]  (include only if there are real findings)

[Within each category, one finding per paragraph:
**[ID] — [one-line title].** `path/file.ts:line`. [Explanation with a brief quoted snippet as
evidence, why it matters, and the reachability/impact.] **Fix:** [concrete change].
Prefix Critical/High findings with stable IDs (C1, H2, ...) so the summary and plan can reference them.]

## Positive notes (verified healthy)
[Specific things done well, with file references. This calibrates the review and earns trust.]

## Phased remediation plan
[Phase 0 = low-effort/high-impact hotfixes (often one-line security guards). Later phases = the
refactors, structural cleanups, and test-debt paydown. Note which refactors are net-negative LOC.]
```

## Severity rubric

Keep this consistent — inconsistent severity is the fastest way to lose the reader's trust.

- **Critical** — exploitable remotely or triggerable in normal use with severe impact: arbitrary file write/delete/read, RCE, auth bypass, silent data loss on the happy path. Fix before shipping.
- **High** — serious but needs a precondition, a specific trigger, or a narrower blast radius: SSRF, secret leakage into logs/context, unsandboxed exec behind a flag, unlocked concurrent writes that lose data under load.
- **Medium** — real bug or significant maintainability/security-hardening issue that won't fire in the common path: swallowed errors, inconsistent error contracts, missing defense-in-depth, large-scale duplication, oversized modules.
- **Low** — dead code, magic constants, redundant type casts, minor UX/a11y, naming, doc drift.

Severity is impact × likelihood **relative to the stated threat model**. State the assumption (e.g. "assumes route inputs are untrusted because installed apps call them same-origin"). If the model is different (single-user localhost, no untrusted input), say how severities shift.

## Principles

- **Evidence over assertion.** Every finding names a file and line and quotes enough to prove it. "This module is messy" is not a finding; "`store.ts:169` writes `path.join(dir, rel)` where `rel` is an unvalidated request-body key, allowing `../../` escape" is.
- **Root causes over symptoms.** When the same bug appears in ten files, the finding is the missing shared helper, not ten separate line items. Quantify the recurrence — it's what justifies the refactor.
- **Be fair.** Call out what's well-built. A review that only lists problems reads as posturing and gets discounted.
- **Actionable and phased.** The plan should let the team start today: the one-line hotfixes first, the big refactors sequenced after, with an honest note on effort.
- **Verify before you alarm.** Confirm every Critical/High yourself. Converging independent findings raise confidence; a single unconfirmed one gets checked or dropped.

## Environment notes

- **Read-only.** This skill reviews; it does not edit. Offer to implement fixes as a follow-up, ideally on a feature branch.
- **No subagents** (e.g. Claude.ai): do the domains sequentially, same structure. Slower, still thorough.
- **Large repos**: if a domain is itself too big for one agent, sub-partition it. Keep each agent's scope to something readable in one sitting.
```
