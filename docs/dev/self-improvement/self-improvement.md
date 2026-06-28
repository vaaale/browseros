# Self-improvement subsystem (skills, review, GEPA, curator)

Spec: `spec/self-improvement/self-improvement.md`. User‑facing:
`docs/usage/self-improvement/`.

The assistant improves by updating **memory** (who/what) and **skills** (how). This
page covers the skill library and the three learning passes.

---

## Skill library (`src/lib/agent/skills/store.ts`, server‑only)

A skill is a folder `data/skills/<id>/SKILL.md` (+ optional `scripts/`,
`references/`), or a flat `data/skills/<id>.md`. Frontmatter:
`name, description, whenToUse, pinned?, score?` + a markdown body (the procedure).

API surface: `listSkills`, `loadSkill(id)`, `saveSkill`, `deleteSkill`,
script/reference CRUD, and `skillsIndex()` (the name + when‑to‑use digest injected
into instructions). Full bodies load **on demand** (`loadSkill` action) so the
prompt stays small.

**Seeded skills** (when `data/skills` is empty):

- `summarize-web-page` — fetch a URL and summarize faithfully.
- `develop-in-browseros` — triage *build an app* vs *modify BOS*, delegating to the
  Claude `developer` agent. References (`building-apps`, `modifying-bos-features`)
  are stored as skill references.

---

## Usage telemetry (`skills/usage.ts`)

A per‑skill `.usage.json` sidecar tracks `useCount`, `patchCount`,
`lastActivityAt`. `recordSkillUsed` / `recordSkillPatched` update it;
`loadUsage` reads it. Drives Curator decisions.

---

## Pass 1 — review / reflect (`src/lib/agent/review.ts`)

`reflectAndLearn` (action) → `/api/assistant/reflect` → `runReview(transcript)`:

- A **separate** LLM pass over the finished conversation with a **restricted
  toolset**: only `MEMORY_LLM_TOOL` and skill create/patch tools. It takes no other
  actions and never touches the live chat.
- Routes durable user facts → **memory**; reusable procedure/style corrections →
  **skills** (preferring to **patch** an existing skill over creating one).
- "Nothing to save" is a valid result. Explicitly avoids hardening transient or
  environment‑specific failures.
- Gated by `hasCredentials()`.

---

## Pass 2 — improve a skill / GEPA (`skills/improve.ts`)

`improveSkill` (action) → `/api/skills/improve`: a reflective rewrite of one skill's
instructions from feedback, recording a self‑reported **`score`** on the new
version.

> This is **GEPA‑lite**: a single reflective optimization, not the full GEPA loop
> (candidate generation + evaluation against representative tasks + Pareto selection
> + versioned rollback). See `spec/discrepancies.md`.

---

## Pass 3 — curator (`skills/curator.ts`)

`runCurator` (action) → `/api/skills/curator`: archives skills with no recent
activity (`lastActivityAt` older than a threshold) by moving them into
`data/skills/.archive/` (**recoverable, never deleted**). It **only** touches
**agent‑created** skills and **skips pinned** ones (pinning protects from archiving
but not from improvement). Runs **on demand** (no persistent scheduler).

---

## Recipe: extend learning

- New durable knowledge type → decide memory vs skill; don't add a third store.
- Adjust Curator policy in `curator.ts`; keep "archive, don't delete" and the
  pinned/seeded protections.
- If you implement full GEPA, add candidate evaluation + version retention and
  update the spec + `discrepancies.md`.
