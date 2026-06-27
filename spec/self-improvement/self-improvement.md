# BrowserOS Self-Improvement — Specification

BOS's assistant must **get better over time from its own experience and from user feedback** — turning conversations into durable improvements to its memory, its skills, and (where appropriate) to BOS itself. This document specifies how. It expands the `spec/bos.md` requirements ("Agent self improvement" and "BOS Self improvement") and is informed by a study of Hermes-Agent (`agent/background_review.py`, `agent/curator.py`, `tools/skill_manager_tool.py`, `cron/suggestions.py`).

It pairs with `spec/memory/memory.md`: that document specifies the **memory substrate** (the surfaces, storage, the memory tool, recall); this document specifies the **learning loop** that decides what to write and how the skill library evolves. Where they overlap, this document is authoritative for the loop and lifecycle; `memory.md` is authoritative for the storage and the memory tool.

## Two scopes of self-improvement

1. **Agent self-improvement (primary).** The assistant learns from each task and updates its **memory** (who the user is, current state) and its **skills** (how to do a class of task), optimizes skills over time, and curates the skill library. This is the Hermes-style loop and the bulk of this spec (§1–§7).
2. **BOS self-improvement (codebase).** Improving BOS's own apps, features, and architecture over time — a development activity carried out by the developer sub-agent against the source (§8).

These are distinct: agent learning edits runtime data (`data/memory`, `data/skills`); BOS self-improvement edits source (`src/`).

---

## 1. Principles

- **Learn continuously, but conservatively.** Capture only durable, high-signal, generalizable lessons. A learning that only made sense for today's one-off task is noise.
- **Right surface for the lesson.** *How to do a class of task* → a **skill**. *Who the user is / durable preferences / current state* → **memory**. A user preference about how a class of task should be done belongs in the **skill body**, not only in memory.
- **Never harden transient or environment-specific failures** (missing binaries, unconfigured credentials, "command not found", a momentarily-broken tool) into permanent rules. These become self-imposed constraints that bite later when the environment changes. Capture the *fix*, never "X does not work."
- **Reversibility over destruction.** Skills are archived, never auto-deleted; skill edits are versioned; BOS code changes happen on a feature branch.
- **Consolidate, don't proliferate.** Prefer improving an existing class-level skill over spawning a new narrow one.
- **Consent and oversight.** Proactive proposals and source-code changes require user consent; the learning loop itself takes no real-world actions.

---

## 2. The reflective learning loop (post-task review)

This is the engine of agent self-improvement: after a task, the assistant reflects on the conversation and decides what memory and skills to save or update.

### 2.1 Execution
- **Trigger.** The review MUST run after a completed, non-trivial task/turn. It SHOULD be debounced/skippable for trivial exchanges, and MUST be configurable (on/off, and which model runs it).
- **Separate pass.** It MUST run as a separate evaluation (a background/forked pass), NOT inline in the user-facing turn. It replays a snapshot of the conversation and asks: *"Should any memory or skill be saved or updated?"*
- **Restricted toolset.** The review MUST run with access to **only the memory and skill-management tools.** Every other tool is denied. It takes no real-world actions; it only curates memory and skills.
- **Isolation.** Writes go directly to the memory and skill stores. The live conversation and its prompt cache MUST NOT be mutated by the review.
- **Cost.** It SHOULD reuse the main model/context where possible (warm prefix cache → cheap replay), and MAY be routed to a cheaper auxiliary model (in which case it replays a compact digest rather than the full transcript).
- **Transparency.** The review MUST produce a concise, human-readable summary of what it saved/updated, surfaced in the UI and/or the Memory app. Writes MAY be gated by approval (see `memory.md` §8).

### 2.2 What it decides
- **Memory:** did the user reveal persona, preferences, personal details, or expectations about how the assistant should behave? Save them (per `memory.md`).
- **Skills:** be **active** — most non-trivial sessions produce at least one skill update, even a small one. A pass that does nothing on a session full of corrections is a missed learning opportunity. *"Nothing to save"* is nonetheless a valid outcome for a smooth session with no corrections and no new technique.

### 2.3 Skill-worthy signals (any one warrants action)
- The user corrected the assistant's **style, tone, format, legibility, verbosity, or approach.** Frustration ("stop doing X", "too verbose", "just give me the answer", "you always do Y") and an explicit "remember this" are **first-class skill signals**, not merely memory signals — embed the lesson in the skill that governs that class of task so the next session starts already corrected.
- The user corrected a **workflow or sequence of steps** — encode it as an explicit step or a pitfall in the relevant skill.
- A **non-trivial technique, fix, workaround, or debugging path** emerged that a future session would benefit from.
- A skill that was loaded/consulted turned out **wrong, missing a step, or outdated** — patch it.

### 2.4 Preference order (pick the earliest that fits)
1. **Update a currently-loaded skill** — if a skill was in play this session and covers the learning, patch it first.
2. **Update an existing umbrella skill** — broaden a trigger, add a subsection or a pitfall.
3. **Add a support file** under an existing umbrella — `references/<topic>.md`, `templates/<name>`, or `scripts/<name>` — with a one-line pointer added to the `SKILL.md`.
4. **Create a new class-level umbrella skill** — only when no existing skill covers the class, and only with a class-level name (never a session artifact like a bug id, error string, codename, or "fix-X-today").

### 2.5 Anti-patterns the loop MUST NOT capture
These harden into persistent self-imposed constraints:
- **Environment-dependent failures** (missing binaries, fresh-install errors, "command not found", unconfigured credentials, uninstalled packages). The user can fix these; capture the **fix** under a troubleshooting skill, never "this tool doesn't work."
- **Negative claims about tools/features** ("browser is broken", "can't use Y") — they become refusals the agent cites against itself long after the cause is fixed.
- **Session-specific transient errors** that resolved before the session ended — if a retry worked, the lesson is the retry pattern, not the original failure.
- **One-off task narratives** — "summarize today's news" is not a class of work that warrants a skill.

---

## 3. Skills as the unit of procedural improvement

(Skill structure is specified in `spec/bos.md`; this section covers how the loop creates and edits them.)

- A skill is a directory: `SKILL.md` (frontmatter: name, one-sentence description, when-to-use; body) plus optional `references/`, `scripts/`, `templates/`.
- Skills carry **provenance** (`agent`-created vs seeded/built-in), which governs the lifecycle in §5.
- The library MUST trend toward **class-level "umbrella" skills** — a rich `SKILL.md` with a `references/` directory for specifics — not a flat list of one-session skills.
- Skill mutation MUST support: **create**, **edit** (full rewrite), **patch** (targeted find-and-replace in `SKILL.md` or a support file), **delete** (agent-created, non-pinned only), and **add/remove support files**.
- **Auto-creation from conversation** (per `spec/bos.md`): when a new class of task with a reusable procedure emerges, the loop SHOULD create a skill — subject to the class-level-naming rule and the anti-patterns above.

---

## 4. Skill optimization over time (GEPA)

Beyond per-session patches, BOS MUST be able to **improve a skill's instructions from accumulated feedback and self-reflection** — the GEPA-style reflective optimizer named in `spec/bos.md` ("Use GEPA to improve any skill over time based on feedback from the user or self-reflection").

GEPA-style optimization MUST work by **reflection, not blind appending**:
- **Reflective mutation.** From execution traces (what the skill produced, where it failed), user feedback, and self-reflection, an optimizer proposes an improved version of the skill's instructions in natural language — diagnosing *why* the previous version underperformed and rewriting accordingly.
- **Candidate evaluation & scoring.** Proposed variants are evaluated against representative tasks / acceptance criteria and assigned a performance **score**. Selection SHOULD prefer candidates that are better across multiple cases (a Pareto/score-based choice), not ones that overfit a single example.
- **Iterative & bounded.** Optimization proceeds in bounded rounds; the best-scoring variant becomes active. Prior versions MUST be retained for rollback.
- **Triggers.** GEPA optimization SHOULD run on: explicit user feedback about a skill or approach; self-reflection (§6) flagging a weakness; or repeated failures of a skill.

The per-session review (§2) *patches* skills with point lessons; GEPA *optimizes* a skill's instructions holistically from many signals. Both update the same skill files.

---

## 5. Skill lifecycle — the Curator

Continuous skill creation will rot the library without maintenance. A background **Curator** MUST manage the lifecycle of **agent-created** skills.

- **Telemetry.** Per-skill usage is tracked in a sidecar (use count, view count, patch count, last-activity time, lifecycle state, pinned flag).
- **Trigger.** The Curator runs periodically — when the assistant is idle and the configured interval has elapsed — and persists its scheduler/status state (last-run, paused).
- **Deterministic staleness transitions.** Skills move `active → stale → archived` based on idle-time thresholds. This deterministic pass MUST always run; an LLM **consolidation** pass (merging overlapping skills) is opt-in and runs at most at the same cadence.
- **Archive, never delete.** The maximum destructive action is **archive**, and archives MUST be restorable. The Curator MUST take a backup snapshot before a destructive pass.
- **Provenance & protection.** The Curator MUST only touch **agent-created** skills. Seeded/built-in skills are off-limits (optionally prunable behind an explicit setting + a suppression list that survives re-seeds). **Pinned** skills are exempt from auto-archive/consolidation but MAY still receive content improvements (pin blocks removal, not patching).
- **Division of labor.** The review loop (§2) *creates and patches*; the Curator *retires and consolidates at scale*. When the review notices two overlapping skills, it SHOULD flag them rather than merge mid-task, leaving consolidation to the Curator.
- **Configuration.** enable/disable, interval, minimum-idle, stale-after, archive-after, prune-bundled.

---

## 6. Self-evaluation (scoring performance)

The assistant MUST be able to **assess how well it performed a task** (self-reflection), and that assessment feeds the rest of the system:
- It decides whether the review (§2) should act, and what to capture.
- It updates each skill's **performance score** from outcomes and feedback, which prioritizes GEPA optimization (§4) and informs the Curator.
- Signals include: user satisfaction vs. corrections, task success/failure, retries needed, and whether the user accepted the output.

Self-evaluation MUST be honest about failure (a task that needed three corrections is not a success) — otherwise the loop learns the wrong lessons.

---

## 7. Proactive self-improvement (suggestions)

The learning loop MAY notice **recurring asks or patterns** and propose improvements rather than only reacting:
- Proposals MAY include a new skill, a saved memory, or an **automation** (e.g. a scheduled job for a recurring request).
- Proposals MUST be **consent-first**: surfaced as suggestions the user explicitly accepts or dismisses. The system MUST NOT auto-create automations or take proactive actions on its own. Dismissed suggestions MUST NOT be re-offered.

---

## 8. BOS self-improvement (improving BOS itself)

Per `spec/bos.md`, BOS must also improve its own implementation over time. This is a **development** activity, not memory/skill learning:
- When asked to build a new app or feature, the assistant MUST **first evaluate** whether an optimal solution requires architectural changes, and whether such changes would improve BOS's quality — and state this briefly before implementing.
- Improving BOS's own apps, features, or architecture MUST be done by the **developer sub-agent** (Claude) against the source, on a **git feature branch** (minimize blast radius), with changes staged and type-checked and the documentation updated (see the "Develop in BrowserOS" skill and `spec/bos.md`).
- This path edits `src/`; it MUST NOT be conflated with the agent learning loop, which edits `data/`.

---

## 9. Safety & governance

- **No hardened failures.** The loop MUST NOT record transient/environment failures or negative tool claims as durable rules (§2.5).
- **Reversibility.** Skills are archived not deleted; skill optimizations are versioned with rollback; BOS code changes are isolated to a feature branch.
- **Restricted authority.** The review/optimization passes run with a memory+skill-only toolset and take no real-world actions. Proactive proposals and source changes are consent-gated; memory writes MAY be approval-gated.
- **Protected surfaces.** The active agent's core operating policy, seeded/built-in skills, and the user's data are not silently rewritten by the loop.
- **Loop hygiene.** Background passes MUST NOT corrupt the live conversation, its prompt cache, or the user profile (e.g. automated/cron runs MUST NOT write the user profile).

---

## 10. UI & configuration

- The assistant MUST surface **what it learned** — the review's action summary (in the UI and/or the Memory app) and a record of skill changes.
- **Skills** are browsable and editable in Settings → Skills; **memory** in the Memory app.
- **Suggestions** are presented for the user to accept or dismiss.
- Configuration MUST expose at least: whether the review runs and which model it uses; GEPA optimization triggers; Curator settings (interval, staleness/archive thresholds, prune-bundled); and the proactive-suggestions toggle. Per the BOS configuration system, exposing these as a config namespace also exposes them to the assistant as tools.

---

## 11. Relationship to other specs

- **`spec/memory/memory.md`** — the memory substrate the loop writes to (surfaces, storage, the memory tool, recall, safety). The "what to save / what to skip" guidance for memory lives there.
- **`spec/bos.md`** — skills, sub-agents and delegation, the developer sub-agent, the feature-branch policy, and the BOS-self-improvement requirement that §8 elaborates.
