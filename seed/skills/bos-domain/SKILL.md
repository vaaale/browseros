---
name: bos-domain
description: What BOS is actually made of — the three implementation shapes, where each kind of thing lives, BOS's real architectural containers, and the install/delegation mechanics. Facts, not process.
when_to_use: Whenever you need to classify a feature (bos-core / builtin-app / marketplace-item), name a real BOS container, or work out how something is installed, delegated or served. Load this before designing, planning or implementing anything in BOS, under any spec framework.
created_by: seed
pinned: true
---

This skill holds **facts about BOS**. Everything here is true regardless of which spec framework is driving the work — spec-kit, OpenSpec, BMAD or anything else. If a sentence here would change when the framework changes, it is in the wrong place and belongs to that framework's own driver skill.

That split is deliberate: BOS's domain knowledge is loaded by many different roles — the architect, the UI designer, whoever is capturing intent, and any framework pack's own cast — so it lives in exactly one place and is referenced by id, never copied.

## Where BOS's own map already is

BOS maintains its own subsystem map — don't rediscover it from scratch with `ls -R`/generic dependency scans the way you would on an unfamiliar codebase. Read `docs/dev/architecture-overview.md` (subsystem inventory + dependency graph + stability ratings) and `docs/dev/extending-bos.md` (concrete "add X" recipes) first. Then use `bos_source_search`/`bos_source_read` to verify the SPECIFIC area you're working on against the actual current code — docs drift; the source is truth when they disagree.

## The three implementation shapes

Every BOS app/feature/service is one of exactly three shapes — note that "app" and "service" are FACETS of the third shape, not separate shapes; most non-trivial marketplace items have both.

| Shape | What it is | Where it lives |
|---|---|---|
| `bos-core` | Part of BOS itself — Settings, desktop, API routes, server logic that isn't a self-contained app/service | `src/` |
| `builtin-app` | A first-class window app compiled into BOS | `src/apps/<id>/` |
| `marketplace-item` | A self-contained, installable item, not a BOS-source change — an app facet (`app/`, an iframe UI), a service facet (`services/`, an independent worker-thread daemon on its own port, outside Next.js entirely), or both together | `data/user-apps/items/<id>/` |

The full anatomy of each — what files it needs, how it is installed, how work is delegated to build it — is in this skill's references:

- `references/target-bos-core.md`
- `references/target-builtin-app.md`
- `references/target-marketplace-item.md`

Read the matching one in full before acting on a classification. The table above tells you which row applies; it does **not** tell you how to build that shape correctly.

**The one mistake to actively guard against:** concluding "this needs to change BOS source" because of a technical limitation of Next.js/the App Router (can't handle a non-standard HTTP verb, can't run continuously, needs a raw protocol) — without checking whether a `marketplace-item`'s service facet sidesteps the limitation entirely by never running inside Next.js in the first place. This happened for real once (a WebDAV mount feature wrongly concluded it needed `src/middleware.ts`); the correct answer was an independent worker-thread service, zero `src/` changes. Treat "Next.js can't do X" as a reason to check `target-marketplace-item.md`, never as a conclusion on its own.

**A second mistake to avoid:** don't split one feature into a "marketplace-app part" and a "marketplace-service part" as if they need separate classifications or separate delegations. If a design needs both a UI and a background daemon, it's one `marketplace-item` with two facets — design and install them together.

If built-in vs. marketplace is the live question (not core-vs-item), use the decision checklist in `docs/dev/guides/apps.md` §1: direct OS state / internal APIs / thin wrapper around a BOS subsystem → built-in; self-contained tool with its own lifecycle → marketplace.

State the classification and rationale explicitly, in that exact vocabulary — it needs to drop straight into a spec's `App Target` field (or the equivalent field in whatever framework is active) without translation.

## BOS's real containers

When describing where something runs, use BOS's actual containers. Never substitute a generic one ("the API", "the database") that has no BOS counterpart.

- The **Next.js app process** — everything behind `src/app/api/**/route.ts`, plus SSR.
- The **Supervisor** and its preview worktrees — owns lifecycle, preview, promote and rollback for BOS's self-modification.
- A **worker-thread service process** (`ServiceManager.ts`) — an installed item's own daemon, on its own port, outside Next.js entirely.
- A **marketplace item's own git repo** — `data/user-apps/` or a registered marketplace clone.
- The **VFS/GitFS stores** — the user's sandbox and the git-backed content roots.
- **Bastion** — the multi-user proxy and per-user container supervisor, if the work is deployment-relevant.

## Reaching this skill

Load it by id (`skill_load`), and read its references with `skill_read_file`. Never reach into another skill's `references/` by path — that coupling is exactly what this skill exists to remove.
