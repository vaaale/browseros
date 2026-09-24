# Self-improvement subsystem (skills, review, GEPA, curator)

Spec: `specs/003-self-improvement/spec.md`. User‑facing:
`docs/usage/self-improvement/`.

The assistant improves by updating **memory** (who/what) and **skills** (how). This
page covers the skill library and the three learning passes.

---

## Skill library (`src/lib/agent/skills/store.ts`, server‑only)

A skill is a folder `data/skills/<id>/SKILL.md` (+ optional `scripts/`,
`references/`), or a flat `data/skills/<id>.md`. Frontmatter:
`name, description, whenToUse, pinned?, score?` + a markdown body (the procedure).

Tools (context "both" — main chat + sub-agents): `skill_list`, `skill_load`,
`skill_read_file` (bundled references/scripts), `skill_save`. Store API
(`skills/store.ts`): `listSkills`, `getSkill`, `readSkillFile`, `listSkillFiles`,
`saveSkill`, `removeSkill`. The skills index (name + when‑to‑use digest) is injected
into instructions; full bodies load **on demand** (`skill_load`) so the prompt stays
small, and a skill's bundled scripts are run via `run_command` (pass `skill=<id>` to
stage them into the sandbox workspace).

**Seeded skills** live in `seed/skills/<id>/` (SKILL.md + optional `scripts/`,
`references/`) and are reconciled into `data/skills/` on boot — see below.
`build-studio` (pipeline process), `bos-domain` (BOS's own facts) and `intent`
(requirements capture) are the load-bearing ones; `bos-domain`'s
`references/target-*.md` carry the per-target build rules.

---

## Seed reconciliation (`src/lib/agent/seed-sync.ts`)

`seed/` is BOS source; `data/skills/` and `data/agents/` are the deployment's.
Seeding used to be **additive only** — an id was written when absent and never
again — which made `seed/` a first-boot template rather than an update channel:
a shipped fix to an existing skill, a corrected reference document, or a
deletion could never reach a deployment that had already booted once.

It can't simply overwrite, either: `skill_improve`'s reflective optimizer
rewrites a skill's body and score in place, and Settings edits do the same for
agents. So each copy carries a sidecar stamp, `data/<store>/<id>/.seed-rev`,
holding **two** hashes:

| field | covers | answers |
|---|---|---|
| `seed` | the seed content it was materialized from | has the shipped version moved on? |
| `live` | the bytes BOS itself last wrote | has anything touched it since? |

Both are needed because **what BOS writes is not the seed content byte-for-byte**:
an agent is rewritten by the allowlist/conflict-tool backfills right after
seeding, and a skill is re-serialized by `writeSkill` (which adds `created_by`
and splits assets into subfolders). A single hash made every id look locally
modified the instant it was written, so nothing ever updated.

Per id, on boot (`decideSeedAction`):

| state | action |
|---|---|
| no `data/` copy | **seed** it |
| `live` matches disk, `seed` differs from the current seed | **update** in place |
| `live` matches disk, id gone from `seed/` | **archive** to `.archive/<id>` |
| `live` doesn't match, or no stamp | **leave alone** — it's local now |

A skill's hash covers its `references/` and `scripts/` too, not just SKILL.md —
a change confined to one reference document is a real change.

Guardrails: an empty/unreadable seed listing never reads as "everything was
deleted"; dropped ids are archived, never deleted; the default-prompt agent is
never archived; and an agent refresh clears the one-shot migration markers so
the tool-allowlist backfill re-applies (the seed's own frontmatter has no
`tools` field, and under *empty allowlist = zero tools* an updated agent would
otherwise come back mute).

**One-time migration.** A deployment seeded before this existed has no stamp
anywhere, so every seeded copy reads as local and stays frozen. There is no way
around it — no record of which seed revision those copies came from was ever
kept, so "untouched" is unprovable and guessing would overwrite real edits. To
adopt the shipped version of a given id once, delete `data/skills/<id>/` (or
`data/agents/<id>/`) and restart; it re-seeds stamped, and tracks from then on.

### Retiring a skill needs an operator step, and the obvious rule is wrong

Deleting a skill from `seed/` does **not** remove it from a deployment.
`archiveDroppedSeedSkills` calls `decideSeedAction` with `inSeed: false`, but the
`local` guard fires first and catches **unstamped** copies as well as genuinely
edited ones — and on a deployment seeded before stamping existed, *every* copy is
unstamped. A retired skill therefore stays in the index and stays loadable
forever unless someone deletes it by hand.

The intuitive clean-up rule — *"delete whatever still has a counterpart in
`seed/`"* — is exactly backwards: once the retirement lands, the retired ids have
no counterpart, so that rule spares precisely the ones that must go. State the
clean-up as a list, never as a principle:

- **Must delete** — the retired ids themselves. They exist in no `seed/` and no
  marketplace, so nothing will ever remove or update them for you.
- **Should delete** — everything still present in `seed/`. Nothing is lost
  (they re-seed on boot) and they come back **stamped**, which is what makes
  every future retirement archive correctly with no further intervention.
- **Indifferent** — skills belonging to an installed item (e.g.
  `okf-bundle-schema`, `okf-ingest-workflow`, `workflow-manager`).
  `reconcileInstalledItemAssets` restores them from the item on boot.
- **Must keep** — any skill with `created_by: seed` that is absent from today's
  `seed/` and offered by no marketplace. `summarize-a-web-page` is the live
  example: it carries its own `scripts/` and `references/`, and deleting it
  destroys the only copy.

In practice the simplest correct instruction is **delete everything under
`data/skills/` except the "must keep" list, then restart** — which both completes
the retirement and repairs the unstamped state in one pass.

---

## Usage telemetry (`skills/usage.ts`)

A per‑skill `.usage.json` sidecar tracks `useCount`, `patchCount`,
`lastActivityAt`. `recordSkillUsed` / `recordSkillPatched` update it;
`loadUsage` reads it. Drives Curator decisions.

---

## Pass 1 — memory loops (fast/slow, spec 021)

The original voluntary `skill_reflect` → `runReview(transcript)` pass (spec 003) has
been retired and removed — `/api/assistant/reflect` now runs the **fast loop**
instead, and consolidation into long-term memory is a separate **slow loop**. See
`docs/dev/memory/memory.md` for the full mechanism: automated scheduler jobs
(`memory.fast-loop` / `memory.slow-loop`) that scan conversations, write episodes,
and consolidate them into memory/skill updates — no longer a single manual
end-of-task action.

---

## Pass 2 — improve a skill / GEPA (`skills/improve.ts`)

`skill_improve` (action) → `/api/skills/improve`: a reflective rewrite of one skill's
instructions from feedback, recording a self‑reported **`score`** on the new
version.

> This is **GEPA‑lite**: a single reflective optimization, not the full GEPA loop
> (candidate generation + evaluation against representative tasks + Pareto selection
> + versioned rollback). See `specs/discrepancies.md`.

---

## Pass 3 — curator (`skills/curator.ts`)

`skill_curate` (action) → `/api/skills/curator`: archives skills with no recent
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
