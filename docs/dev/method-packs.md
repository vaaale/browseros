# Method packs — authoring a spec framework for BOS

*(045-method-pack-layer)*

BOS drove GitHub spec-kit exclusively until 045: its nine phases were a
TypeScript union, the phase strip hardcoded their labels, `spec.md` was the
leaf marker in four separate places, and `.specify/templates` was *the*
template root. A different framework — OpenSpec, BMAD — could not be expressed
without changing BOS's source.

Now a framework is **data**: a `MethodDescriptor`. BOS ships spec-kit as one,
in exactly the shape a marketplace pack uses, and evaluates both through the
same code. There is no `builtin` branch in the pipeline.

## The descriptor

`src/lib/specs/method/types.ts` is the authority; this is the shape and the
reasoning.

```jsonc
{
  "schemaVersion": 1,
  "id": "openspec", "label": "OpenSpec", "version": "1.0.0",

  // What counts as a unit, and where.
  "sections": [
    { "rel": "changes", "kind": "active",  "leafMarker": "proposal.md", "numbering": "none" },
    { "rel": "specs",   "kind": "truth",   "leafMarker": "spec.md",     "numbering": "none" },
    { "rel": "archive", "kind": "archive", "leafMarker": "proposal.md", "numbering": "none",
      "terminal": true, "terminalLabel": "Archived" }
  ],

  "constitution": "openspec/project.md",
  "constitutionRoot": "own",
  "discrepancies": { "rel": "discrepancies.md", "roots": ["own"] },

  "artifacts":     [{ "id": "proposal.md", "generates": "propose" }],
  "artifactOrder": ["proposal.md", "design.md", "tasks.md"],

  "phases": [ /* see below */ ],
  "stateLabels": { "done": "Done", "pending": "Available", "blocked": "Blocked", "na": "N/A" },

  "templates": "method/templates",
  "agents": ["openspec-driver"],
  "roles":  { "driver": "openspec-driver" }
}
```

### Phases are ordered clause lists, not booleans

Each phase declares `rules[]`, evaluated **in order, first match wins**. If no
rule matches, the phase is `blocked` when a `requires` edge is unsatisfied,
otherwise its `else` (default `pending`).

```jsonc
{
  "id": "tasks", "label": "Tasks", "requires": [],
  "rules": [
    { "when": { "kind": "exists", "file": { "rel": "tasks.md" } }, "then": "done" },
    { "when": { "kind": "exists", "file": { "rel": "design.md" } }, "then": "pending" }
  ],
  "else": "na"
}
```

Order is semantic. A "done" clause must precede the weaker "in progress"
clause, or the stronger evidence is never consulted.

### `requires` edges are usually the wrong tool

It is tempting to wire phases into a linear chain. Spec-kit declares
`requires: []` on **all nine** and puts its gating in the clauses instead,
because the edges change output at scale: `converge requires implement` flips
120 of 132 real features from `na` to `blocked`, since `implement` is `done` on
only 12. Reach for an edge only when a phase is genuinely *unreachable* until
another completes — not merely "usually comes after".

Edges are consulted **last**, after the clauses. A phase whose artifact
demonstrably exists reports on that evidence rather than on its predecessors.

### Predicates

| Predicate | Meaning |
|---|---|
| `exists` | present in the directory **listing** |
| `nonEmpty` | present **and non-empty** — an empty file is not evidence |
| `contains` / `notContains` | substring of the file body |
| `checklist` | `- [ ]` / `- [x]` items, quantifier `all` / `any` / `none` |
| `containsUnitId` | the file mentions this unit's id |
| `dependsOn` | another phase resolved to a state |
| `set` | quantify an inner predicate over a glob |
| `count` | how many files match a glob |
| `all` / `any` / `not` | boolean combinators |
| `manual` | always true — BOS cannot observe this phase; pair with `then: "na"` |

Two traps worth stating outright:

- **`exists` vs `nonEmpty`.** If a phase keys on a report file, an empty one
  almost certainly means "not run", not "run with no output". Use `nonEmpty`.
- **Every `checklist` and `set` quantifier is FALSE on an empty collection.**
  A framework with no stories yet must not read as "all stories complete". This
  is deliberate, and it is why `checklist: all` cannot be used to mean "nothing
  left to do" on a unit that has no task list.

### Artifacts of unknown cardinality

A framework that shards work into one file per story cannot name its artifacts
up front. Quantify over a glob instead — no BOS code changes:

```jsonc
{ "when": { "kind": "set", "glob": "stories/*.md", "quantifier": "all",
            "of": { "kind": "checklist", "file": { "rel": "" }, "quantifier": "all" } },
  "then": "done" }
```

### `constitutionRoot` and `discrepancies.roots`

Both say *which store* a store-scoped file is read from: `own`, `system`, or
`user`. Spec-kit reads one constitution from the **system** store for every
store — including item-owned ones — so `constitutionRoot: "system"`. Getting
this wrong is not cosmetic: resolving per-store instead flips every item store
from `done` to `pending`.

### `artifactOrder` is separate from `artifacts`

`artifacts[]` describes what generates what. `artifactOrder[]` is display
order only. Names absent from it sort **after** everything in it,
alphabetically — spec-kit relies on that tail for `design.md` and
`test-results.md`.

## Packaging

Every descriptor must declare **`storeRoot`** — where this method keeps specs
inside a user's repository (`specs` for spec-kit, `openspec` for OpenSpec, `docs`
for BMAD), or `"."` if it writes at the repo root. `registerMethod` refuses a
descriptor without it, naming the pack.

It is required rather than defaulted because the field decides what BOS does to
someone else's source tree, and the default hid its own absence: with "absent ⇒
the repo root", a pack that MEANT the root and a pack that FORGOT looked
identical. Two shipped packs forgot, and the only symptom was silence —
`detectMethod` skips a pack with no `storeRoot`, so a repository already laid out
for that framework was never offered it, and registering with the pack anyway
dropped the spec store at the repo root. `"."` is what makes "I write beside the
code" sayable, so refusing absence costs nothing.

A pack is an ordinary marketplace item (035: install copies nothing — one
symlink):

```
my-method/
├── method/
│   ├── method.json          # the descriptor: storeRoot, agentsDir, agentVisibility, …
│   ├── templates/           # mounted at /Methods/<id>/templates
│   └── agents/<id>/AGENT.md # the cast this framework's process assumes
└── marketplace.json         # item entry with a `method` facet
```

`agentVisibility: "delegate-only"` keeps a pack's internal cast out of the
agent picker while leaving it fully delegatable. Use it for agents a driver
delegates to rather than ones a user starts a conversation with.

### Agents are discovered; skills are linked (or copied)

A pack's **agents** are read from its own root in place. Its **skills** land in
the single skill root `data/skills/` — in one of two forms, decided by whether
the pack is an **installed item**:

- **Installed item** (`data/system/<id>` resolves to the pack root): each skill
  becomes a RELATIVE SYMLINK `data/skills/<skillId>` → `../system/<id>/skills/<skillId>`,
  and the skill store treats it as **read-only** (`Skill.readOnly`). Content
  updates arrive with the item (`git pull` of its marketplace clone); the
  reflective optimizer, Settings edits, and deletion all refuse — uninstalling
  the item removes the links.
- **Not an installed item** (the built-in spec-kit, whose root lives in the
  SOURCE TREE — `data/` may never symlink into a worktree): the skill is COPIED
  with `.installed-from.json` provenance, and stays locally mutable.

| | agents | skills (installed item) | skills (built-in pack) |
|---|---|---|---|
| resolution | multi-root, in place | symlink through the item link | single root (`data/skills/`) |
| how a pack's arrive | discovered | linked at install/reconcile | copied at seed time |
| reconciliation | `.seed-rev` two-hash stamp | the link IS the state | `.installed-from.json` provenance |
| a local edit | wins by precedence | refused (read-only) | reported as a conflict |

A pre-symlink deployment migrates automatically: an installed COPY whose
provenance hash still matches (untouched) is replaced by the symlink on the
next reconcile pass; a locally-edited one is preserved and surfaced through the
usual keep-vs-replace conflict prompt ("replace" adopts the symlink).

#### The provenance hash covers the ASSET, not BOS's bookkeeping about it

`.installed-from.json` records a hash of the whole asset directory, and its only
value is that a mismatch means **the user** changed it. So every file BOS writes
into that directory for its own purposes must be excluded from the hash.

Those filenames are declared once, in **`src/os/asset-bookkeeping.ts`** — the
provenance file, the `.seed-rev` stamp, and each one-time migration marker. Add
a new marker THERE, never privately beside the code that writes it.

When the two disagreed, the result was a permanent false alarm:
`backfillLegacyAllowlists()` walks every directory under `data/agents/` —
marketplace-installed ones included — and drops `.capabilities-migrated` in each.
The next reconciliation pass saw a changed directory and told the user their
agent had been "edited since it was installed". Accepting the update deleted the
marker, the next boot rewrote it, and the prompt came back forever.

Two rules follow, both guarded by `tests/services/bundled-assets.test.ts`:

- **A BOS-authored edit to an installed asset must re-stamp it**
  (`restampInstalledAsset`). Otherwise BOS's own write is indistinguishable from
  the user's, and the user is asked to arbitrate a change they never made.
- **"Keep mine" is not a no-op.** It writes `declined: { sourceHash, localHash }`
  into the provenance. Nothing else on disk distinguishes "the user kept theirs"
  from "nobody has been asked yet", so without it the identical question returns
  on the next pass. Both hashes are stored so the question is re-asked exactly
  when it becomes a new one — the item shipped different content, or the user
  edited theirs again.

Two consequences to keep in mind:

- Relocating a skill into a pack means its `data/` copy is ARCHIVED on the next
  boot (if BOS wrote it and nobody edited it) and then re-copied from the pack.
  On a deployment where that copy is unstamped or edited, it is left alone and
  the pack's version is reported as a **conflict** instead — nothing is
  clobbered, but the relocation does not complete by itself.
- The seeding step must run AFTER the archive and must not ride
  `reconcileInstalledItemAssets()`, which is memoized per data root and consumed
  by the agent store first. Riding it would archive the skill and never put it
  back, in the same process.

### Agent roots can be directories OR providers

A `dir` root is `<id>/AGENT.md` files. A `provider` root is a pure function
returning agents in memory:

```ts
{ kind: "provider", packId, visibility, watch: string[],
  resolve(): Promise<{ agents: Agent[]; phases?: PhaseSpec[] }> }
```

`resolve()` **must emit no files** — generated `AGENT.md` files would be a
derived cache with no natural invalidation point, inside a user-owned tree
where neither the `.seed-rev` nor the provenance contract applies. It is
invoked at **discovery**, not at boot, and cached on `(packId, max mtime over
watch[])`. When that scan is ambiguous — an empty `watch`, an unreadable path —
it **re-resolves** rather than serving what it has: a stale entry means a
just-authored agent does not appear, which reads as the authoring tool being
broken.

**Most packs do not need a provider.** If your cast is checked in as
`AGENT.md` files, use a `dir` root: those are reviewable, diffable, and work
with no code running. Reach for a provider only when the agents genuinely
cannot exist as files — generated per install, or derived from a format you do
not control.

### Four levels of precedence

```
1. data/agents/<id>                          the deployment's own copy
2. data/method-packs/<packId>/agents/<id>    the user's OVERLAY
3. the installed pack root (dir or provider) what the pack ships
4. seed/agents/<id>                          what BOS ships
```

The overlay outranks the pack because it exists to shadow it; `data/agents/`
outranks the overlay because a hand-written BOS agent is a deliberate override.

### The overlay: BOS supplies the location, the pack owns the meaning

`data/method-packs/<packId>/` is a jailed, writable directory mounted at
`/Methods/<id>/overlay`. It exists because an installed pack root is read-only,
so customisation needs somewhere to go.

**BOS does not define what layering means inside it.** A framework that ships
its own customisation mechanism — BMAD's `customize.toml` has a base → team →
user structural merge — owns that; BOS provides the writable location and the
precedence, nothing more. Implementing a second merge on top would give a user
two competing systems and make "which version of this agent am I running" a
question with two answers.

Uninstalling removes the overlay's **mount**, not its **content**: a user's
customisations outliving an uninstall is deliberate, so reinstalling restores
them rather than silently discarding work.

### Modules

A pack may declare selectable sub-bundles:

```jsonc
"modules": [
  { "id": "bmm", "label": "BMad Method", "default": true, "requiresConfig": true,
    "agentsDir": "modules/bmm/agents", "visibility": "delegate-only" }
]
```

`modules` accepts `string[] | ModuleSpec[]` — a bare string normalises to
`{ id, default: true }`, so a pre-existing descriptor keeps working without a
`schemaVersion` bump. Selection is stored in `itemConfigDir`, not in the
descriptor (overwritten on upgrade) and not in the overlay (content, not
settings). Each selected module registers its own root keyed
`<packId>:<moduleId>`, with its own visibility.

### Agent precedence

`data/agents/` → pack roots (sorted by **pack id**) → `seed/agents/`. A local
copy always wins. Two packs offering the same agent id is **reported**, never
resolved silently — that ordering exists so a conflict is visible, not so it
can be quietly broken.

### Origin gate

A pack carrying a `plugin/` facet is server-side code. From your own
`user-apps` it installs freely; from any other marketplace it requires an
explicit opt-in **recorded per pack**. Not a global setting (which would cover
every future pack) and not a dismissible warning (which is not a decision).

## Changing a workflow (051)

There are **two** ways to change how a pipeline behaves, and picking the wrong
one is expensive in a way that shows up months later.

| | overlay (`data/method-packs/<id>/`) | fork (`data/workflows/<id>/`) |
|---|---|---|
| what it changes | one **file** of the pack — a prompt, a template, an agent | the workflow's **structure** — which phases exist, their order, their gates |
| scope | that pack, **everywhere** it is used | a **new named** workflow, bound per store or Project |
| upstream | keeps receiving the pack's improvements, file by file | receives nothing; it is a snapshot |
| needs a fork | no | yes, by definition |

**Reach for the overlay first.** "Our `review` prompt should say this" is an
overlay edit: it survives upgrade, uninstall and reinstall, and every *other*
file in the pack keeps improving. Forking to change one prompt trades a pack you
never have to maintain for one you now do.

**Fork when you want a variant**: "BMAD without the PRD step, for these two
repos, while everything else stays on stock BMAD." That is a different workflow,
not a different opinion about one file.

### Editing a fork

One function, `applyWorkflowEdit`, behind both the Build Studio canvas and the
agent's `methods_edit` tool. The op set is closed: `addPhase`, `removePhase`,
`renamePhase`, `movePhase`, `setRequires`, `setOptional`, `setArtifacts`.

Every edit carries the `rev` it was made against and a mismatch is **refused**,
naming both revisions — otherwise "the user and the agent both edited" resolves
by whoever wrote last, silently.

Every edit is validated before anything is written: dangling references,
duplicate ids, an empty phase list, and dependency cycles over gates *and*
`dependsOn`. A refusal is a normal outcome carrying its reason; a pack's
workflow refuses every structural op and says to fork.

An op that does more than it was told **says so**. Removing a phase drops the
gates pointing at it and orphans the artifacts it produced, and both come back
as warnings. Removing a phase some rule `dependsOn` is refused instead, naming
who depends on it — dropping a clause changes what the surrounding condition
means, and that is not BOS's call.

### Adding a gate is the one warned operation

`phases[].requires` is the only **enforced** edge kind: unsatisfied, the phase
reports `Blocked`. Adding one can flip live features en masse — the measured
case in `PhaseSpec.requires` is 120 of 132 — so before it applies, BOS evaluates
every bound unit twice and reports which would be blocked and **out of how
many**.

The denominator matters. "0 would be blocked" and "nothing is bound to this
workflow, so nothing was checked" are the same number and opposite facts, so an
unbound fork says it was not checked rather than implying safety.

### Upgrading a fork: re-fork and re-apply

A fork records its **baseline** — the source exactly as taken — so
`diff(baseline, yours)` is precisely your own edits, separable from what the
base already said. That delta is *derived*, which is why 051 needs no patch
format, no path selectors and no merge rules.

When the source pack moves on, the canvas says so and `methods_fork_status`
lists what you changed. The upgrade itself is:

> "Upgrade `my-bmad` to the new version of BMAD."

An **agent** does it: fork the pack's current version under a new id, then
re-apply your changes with judgement. That last word is the reason it is not a
merge engine — if the base renamed a phase you had changed, whether your change
still means the same thing is a question worth answering out loud. A merge
engine answers it silently and mechanically.

### There is no "override"

An earlier design had a third mechanism: a pack declaring a customisable
*surface*, patched in place. It was dropped, and the reason is worth keeping.
No pack filled the `overrides` field BOS defined, so the feature was inert on
everything shipped; and the overlay already handles content edits at file
granularity while keeping upstream improvements.

BMAD *does* ship an override surface, in its own format — a `customize.toml` per
skill, resolved `_bmad/custom/<skill>.user.toml` > `_bmad/custom/<skill>.toml` >
the shipped defaults. That is a reason NOT to build a second one: a pack with its
own merge, layered under BOS's, makes "which version of this am I running" a
question with two answers. BOS supplies the writable location and the precedence
between files; what layering means inside a pack's own config is the pack's. What was left was
structural override, which only pays for itself if re-applying onto a moved base
can be done mechanically, and it cannot.

## Assigning a method

`project.json` → `spec-store.json` → your global default (Settings → Build
Studio) → `spec-kit`. At each level `workflow` supersedes `method`, so a store
bound to a fork writes `"workflow": "my-bmad"`. The default is **per user**:
`data/` is a per-user volume under Bastion.

`bos-system-specs` is permanently spec-kit and read-only.

**A marketplace item binds at birth, in `createItemSpec` — not in its callers.**
An item store has no manifest of its own, so its binding lives in the item's own
`spec/spec-store.json` and travels with the item when it is published;
`item-stores.ts` reads `workflow` **and** `method` from there, the same pair the
chain above resolves. Both halves used to be one-sided: `setItemWorkflow` wrote
`workflow` while the reader looked only at `method`, and only Build Studio's
dialog bound at all — `app_spec_create`, which is how the agent creates an app,
had no way to name a method. An app requested "using the BMAD method" therefore
came out reporting spec-kit, with its first artifact written under spec-kit's
leaf marker. Pass `workflow` to `app_spec_create` whenever the user names a
method; an unknown one is refused rather than defaulted.

Binding an item is **branch-scoped end to end**. `setItemWorkflow` merges rather
than reconstructs, so it reads the manifest before writing it — through the SAME
branch, because under the Supervisor a new item exists only in that branch's data
clone and an unbranched read cannot even find the store (it threw `Unknown spec
store "item-<id>"`, one step after the first artifact was written, leaving the app
created and unbound). `methodFor` takes the branch for the same reason: the
binding is read off the STORE RECORD, and a branch-only item has no base record to
read it from.

**Adopt a new method on a NEW store or Project.** Converting an existing one
changes what counts as a unit, and a framework with a different leaf marker
discovers none of the existing content. Preflight will tell you exactly which
paths would stop being visible — including work that exists only on a draft
`bos/*` branch — and refuses rather than warning. The same check runs on a pack
*upgrade* that changes the effective descriptor, which is the more dangerous
case because nobody chose it.

Content is never deleted by a method change. It stops being *discovered*, which
looks identical from the sidebar and is why preflight lists paths rather than a
count.

## Uninstalling

Removes the descriptor, the agent root and the template mount. A store still
bound to the pack renders **"method not installed"** and never silently falls
back to spec-kit — reinterpreting OpenSpec content through spec-kit's rules
produces output that is confident and wrong.
