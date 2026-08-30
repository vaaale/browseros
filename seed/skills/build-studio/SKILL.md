---
name: Build Studio
description: Drive the spec-kit pipeline to author and refine BOS specifications, then delegate implementation to the Developer.
when_to_use: When authoring, refining, designing, planning, analyzing, or implementing a BOS feature through specs — i.e. running any spec-kit step (constitution, specify, clarify, design, plan, tasks, analyze, implement, converge).
created_by: seed
pinned: true
---

The Build Studio skill drives the spec-kit pipeline. **Where a spec's artifacts live depends on its target — this is a physical split, not just a field.** For `bos-core`/`builtin-app`/`n/a`: specs live in external git-backed STORES under BOS_SPECS_ROOT — a BOS-owned system store (id 'bos-system-specs') and your writable 'user-specs' store — reachable through the ordinary `file_*` tools via VFS mounts: `/Specs/bos-system-specs`, `/Specs/user-specs`, `/Templates` (read-only, the spec-kit ENGINE — command prompts and blank templates), and `/Docs` (docs/). Discover stores with `file_list('/Specs')`. Governing principles live in the system store at `/Specs/bos-system-specs/.specify/memory/constitution.md`; per-feature artifacts live at `/Specs/<store>/<NNN-feature>/` (spec.md, plan.md, tasks.md, ...). For `marketplace-item`: ALL artifacts (spec.md, design.md, plan.md, tasks.md, ...) live INSIDE the item itself, addressed as `item-<id>/<artifact>.md`, reachable ONLY through the `app_spec_create`/`app_spec_list`/`app_spec_read`/`app_spec_write`/`app_spec_edit`/`app_spec_patch` tools — never `file_*`, never `/Specs`. See `references/specify.md` and `references/target-marketplace-item.md`.

IMPORTANT — two different path conventions for the SAME artifact: `buildstudio_artifact_open`/`buildstudio_artifact_highlight` (viewer-only, they never return content) take the bare store-prefixed path WITHOUT the `/Specs` mount prefix, e.g. `bos-system-specs/<NNN-feature>/spec.md` or `item-<id>/spec.md`. To actually get the text into context: for a `bos-core`/`builtin-app`/`n/a` target, call `file_read` on the `/Specs/...`-prefixed path; for a `marketplace-item` target, call `app_spec_read` on the bare `item-<id>/...` path instead — `file_read` cannot reach it. Always pair the two: open the artifact for the user to see, and read it (with the matching tool) for yourself.

## What kind of thing are you building? (read this before `implement`)

"Implement" is not one mechanism — it is three, and they are not interchangeable:

| Target | spec.md `App Target` | Reference | Delegation tool | Needs a feature branch? | Spec artifacts live at |
|---|---|---|---|---|---|
| BOS itself (settings, API routes, server logic, desktop) | `bos-core` | `references/target-bos-core.md` | `dev_delegate` | Yes — `dev_branch_request` first | `/Specs/bos-system-specs/<NNN-id>/` (`file_*`) |
| A built-in app under `src/apps/<id>/` | `builtin-app` | `references/target-builtin-app.md` | `dev_delegate` | Yes — `dev_branch_request` first | `/Specs/user-specs/<NNN-id>/` (`file_*`) |
| An item in the user's private marketplace `data/user-apps/items/<id>/` — an app facet, a background-service facet, or BOTH together | `marketplace-item` | `references/target-marketplace-item.md` | `agent_delegate` (`contentOnly:true`) + `app_install`/`app_build` (installs every facet the item has in one call) | **Yes** — `dev_branch_request` first, before ANY `app_spec_*` write or install | INSIDE the item — `item-<id>/` (`app_spec_*` tools, never `file_*`) |

`marketplace-item` is ONE target, not two — do not classify a spec as "app" or "service" and then split it across separate delegations just because it has both a UI and a daemon. A single `app_build` call installs whichever facets the staged item has.

`App Target` is a fixed field near the top of every spec.md (spec-template.md). It is the single source of truth for which row applies — set it during `specify` (or during `bos-app`'s Phase 2), and re-read it (don't rely on conversation memory) at the start of `implement`, at the start of any followup, and whenever you pick up a spec you didn't just author in this session. For `bos-core`/`builtin-app`, re-read it with `file_read`; for `marketplace-item`, with `app_spec_read` — you have to already know which target you're dealing with (e.g. from the conversation, or by checking whether `item-<id>` exists via `app_spec_list`) before you know which tool to use to confirm it.

**Before you ever conclude a feature needs new BOS-source server logic (`bos-core`), check `target-marketplace-item.md` first.** A feature that needs to handle a raw/non-standard protocol, an arbitrary set of HTTP verbs, or run as a continuous background daemon is a strong signal for a marketplace item's **service facet** (an installed item's own worker-thread process, bound to its own configurable port, running entirely outside Next.js) — NOT a reason to add routing/middleware to `src/`. This exact mistake happened for real: a spec for a WebDAV VFS mount reasoned "Next.js route handlers reject PROPFIND/MKCOL/COPY/MOVE, therefore this needs `src/middleware.ts`" — true in isolation, but wrong, because a service daemon was never going through Next.js's request pipeline in the first place (see the Terminal item for the working precedent: a plain worker-thread process alongside a companion app, zero `src/` involvement).

**Mandatory, not optional**: call `skill_read_file` on the matching Reference file and read it in full BEFORE your first delegation call for that target — every single time, even if you've implemented this target category before in an earlier session. The table above tells you which mechanism applies; it does NOT tell you how to invoke it correctly, and guessing from the summary alone is precisely what goes wrong. Getting this wrong (e.g. calling `dev_delegate` for a marketplace item, or forgetting `contentOnly:true`, or phrasing an `agent_delegate` task without the exact trigger words `target-marketplace-item.md` requires) either forces an unnecessary BOS-source feature branch onto a plain item build, or gets the delegation flatly refused by the harness. `target-marketplace-item.md` also covers which Topbar controls actually apply to a given install (it's not always the same pair) and a singleton-draft gotcha.

If a delegation call comes back refused or with an error you don't recognize, that is a signal to go (re-)read the reference, not to improvise a different delegation tool. A real session got its `agent_delegate(contentOnly:true)` call refused because the task text was missing the required trigger phrase — instead of rereading `target-marketplace-item.md`'s Step 1 and fixing the phrasing, the agent fell back to `dev_delegate`, which routed a marketplace item through the BOS-source path and produced an item that was silently missing pieces (no marketplace.json entry, no installable app facet) two follow-up bug reports later. Never treat a refusal as "try the other delegation tool instead" — reread the reference and fix the call.

## Problem reports on something already implemented

If the user is reporting a bug/regression/"this doesn't work" about a feature, app, or spec that already exists, do not investigate it yourself. Identify the target category from the table above (ask one clarifying question only if genuinely ambiguous — e.g. which app), gather the one or two identifiers the Developer needs (spec path; or the app id via `app_list`; or a single `bos_source_search` hit if you already suspect an area), and relay the user's report to the Developer via the matching delegation tool essentially as-is. Do not read source, form your own theory of the bug, or run a multi-step diagnostic pass first — that is what you are delegating. Report the Developer's findings back verbatim/summarized; only re-run `analyze`/`converge` yourself afterward if docs/spec need to catch up.

Pipeline — a strict sequence, not a menu, and **not something you run end-to-end on your own**. Run ONE step, report what you produced, and STOP — the user decides when you move to the next one. Each step's artifact is the ONLY thing you write during it (see "What you write, and when" below — this is the rule a real session broke):
1. constitution — establish/update project principles
2. specify — turn an idea into spec.md (consider stress-testing with devil-s-advocate). Writes: spec.md. Nothing else.
3. clarify — resolve ambiguities, append a Clarifications section to spec.md. Writes: spec.md. Nothing else.
4. design — a structural pass, delegated to `architect` (`references/design.md`), which writes `design.md` into the spec directory itself (a real file, not a response you fold in — for `marketplace-item`, that means `item-<id>/design.md` via `app_spec_write`, which `architect` also has in its toolset; for other targets, `/Specs/<store>/<id>/design.md` via `file_write` as before), then optionally reviewed once by `architect-reviewer` before you move on. Not optional busywork: mandatory whenever the feature has a service/daemon/network-facing component, touches more than one existing subsystem, or its target classification isn't obvious — skippable only for a small, obviously-scoped feature (a config tweak, a one-file settings tab). Writes: `design.md`, but written by `architect`, not by you — see `references/design.md` for the exact sequence and the one-revision cap.
5. plan — produce plan.md (referencing `design.md` rather than repeating it). Writes: plan.md (+ research.md/data-model.md/contracts/ only when warranted).
6. tasks — produce tasks.md. Writes: tasks.md.
7. analyze — cross-artifact consistency check. Writes: nothing (or corrections to spec/plan/tasks via `file_edit`/`app_spec_edit`, matching the target, never a new file type).
8. implement — delegate to the Developer (`dev_delegate` for `bos-core`/`builtin-app`) or to `agent_delegate`+`app_install`/`app_build` (for `marketplace-item`) per the target table above. Writes: nothing yourself, ever — see below.
9. converge — assess code vs spec. Writes: spec/plan/tasks corrections only, via `file_edit`/`app_spec_edit` (matching the target), if drift is found.

devil-s-advocate stress-testing can additionally be inserted after `specify` or before `tasks` — see "Design Integration with Specialized Agents" below.

## Stop between every step — the user drives, you don't autopilot

After finishing ONE step's artifact, present a short summary of what you wrote/changed and STOP. Do not chain into the next step in the same turn, and do not treat a clean result ("the spec looks complete," "tasks are all dependency-ordered") as your own permission to keep going — that judgment is the user's, at every single step boundary, not just at the end.

**`implement` is the hardest gate of all: never call `dev_delegate`, `agent_delegate`, `app_install`, or `app_build` unless the user has explicitly told you, in this conversation, to implement/build it now.** A complete spec.md + plan.md + tasks.md is necessary but never sufficient by itself — approving the plan is not the same as authorizing implementation, and neither is an original request that sounded like "build me X." Still stop at `specify`, `design`, `plan`, and `tasks` and let the user confirm each before moving on, even when the end goal was obviously always to build the thing. If the user explicitly says to run the whole pipeline through to implementation without stopping in between, that's their call and you may honor it — but it has to be said, not inferred from how the request was phrased.

## What you write, and when (this has gone wrong for real)

Until `implement`, the ONLY files you EVER write yourself are spec-kit artifacts — `spec.md`, `plan.md`, `tasks.md`, and their optional companions (`research.md`, `data-model.md`, `contracts/`, checklists) — under `/Specs/<store>/<id>/` (`file_write`) for `bos-core`/`builtin-app`/`n/a`, or under `item-<id>/` (`app_spec_write`/`app_spec_create`) for `marketplace-item`. `design.md` lives alongside them but is written by `architect`, never by you — read it during `plan` with `file_read`, don't recreate or rewrite it yourself. **Never** write anything that looks like the feature's own implementation — `service.json`, `index.js`/`index.ts`, a `config/<id>.json` matching a real item's runtime shape, app source files — at ANY step before `implement`, even "to make the spec concrete" or "to show what it'll look like." That is implementation work. It belongs to the Developer, delegated during `implement` — never to you, at any point in the pipeline, and not even then (you delegate; `app_install`/`app_build`/the Developer's own worktree writes are what actually create those files, never your own `file_write`).

This already happened for real: mid-`specify`, an agent wrote a full `service.json` plus a 400-line `index.js` directly into the spec folder — right after being told, in the very same turn's tool result, to delegate to the Developer instead — then spent an entire session failing to remove them. If you ever catch yourself about to `file_write` (or `run_command`) something that isn't spec.md/plan.md/tasks.md before `implement`, stop and re-read this paragraph instead of proceeding.

**If you do create a wrong file, clean it up with `file_delete` — never `run_command rm`.** `/Specs` (like `/Docs`, `/Templates`, and the user's sandbox) is a VFS mount; `run_command`'s shell does not share that filesystem at all, so a path like `/Specs/user-specs/<id>/foo.json` doesn't exist there. A bare `rm` correctly fails loudly (`No such file or directory`) — that's real signal, not a glitch, and retrying the identical command will not fix it. `rm -rf`/wildcard variants are worse: they can exit 0 ("success") on a path that was never there to begin with, because `-f` silently swallows exactly that error — that is a false positive, not confirmation anything was removed; re-verify with `file_list`, not by trusting the exit code. If a cleanup command fails, or "succeeds" but a follow-up `file_list` still shows the file, the fix is `file_delete` — not another `rm` variant. **If any tool call fails twice with the identical error, stop retrying it** — that's a signal you're using the wrong tool or the wrong filesystem namespace for this location, not a transient failure to push through.

How to run any step:
- Call `skill_read_file` to load the matching reference (references/<step>.md) and follow it — do not proceed from memory of a reference you read earlier in the conversation, or skip straight to acting from this top-level summary alone.
- Read the command prompt and template with `file_read` at `/Templates/commands/<step>.md` and `/Templates/<artifact>-template.md` (always via `file_*` — `/Templates` is a shared, read-only mount regardless of target). Then author the artifact itself: for `bos-core`/`builtin-app`/`n/a`, at `/Specs/<store>/<NNN-feature>/<artifact>.md` via `file_write`/`file_edit`/`file_patch`; for `marketplace-item`, at `item-<id>/<artifact>.md` via `app_spec_write`/`app_spec_edit`/`app_spec_patch` (`app_spec_create` only for the very first `spec.md`, which brings the item into existence). Either way: use the "write" tool ONLY to create a new artifact (or an intentional full rewrite); to MODIFY an existing artifact — adding a section, updating requirements, appending clarifications — read it first, then make targeted changes with the matching "edit" (one change) or "patch" (several ordered find/replace hunks in one atomic call) tool. Never rewrite a whole file just to add or tweak content. Your `file_*` tools only reach VFS mounts (`/Specs`, `/Docs`, `/Templates`, and the user's sandboxed files) — never BOS source, and never `data/user-apps` (that's what `app_spec_*` is for).

## Design Integration with Specialized Agents

### 🏛️ architect (System Design) — this IS pipeline step 4, `design`

See `references/design.md` for the full procedure. Not an optional side-quest like devil-s-advocate below — it's a named pipeline step, mandatory whenever the feature has a service/daemon/network component, touches more than one subsystem, or its target classification isn't obvious. Unlike the other design agents below, it now WRITES: it produces a real `design.md` in the spec directory, not just a response.

**How to delegate**:
agent_delegate( agent: "architect", task: "Write design.md for the spec at [path to spec directory] — context: [details]" )

**Expected output**: `design.md` written into the spec directory (Classification + Context/Container/Component design + a file/module plan of ONLY what this feature creates/modifies + a separate Integration-points list for existing BOS mechanisms it merely calls into + ADRs + risks), plus a short pointer summary as its response. Fold nothing into plan.md yourself — reference `design.md` from `plan.md` instead.

### 🔎 architect-reviewer (Design Review) — runs right after architect, once, as part of the same step

See `references/design.md` §"How to run it" step 5. Independently verifies `design.md`'s claims against real source/docs rather than re-reading it at face value. Read-only — writes nothing, delegates to nothing.

**How to delegate**:
agent_delegate( agent: "architect-reviewer", task: "Review design.md for the spec at [path to spec directory]" )

**Expected output**: a verdict (`Ready for plan` / `Needs one revision round` / `Needs significant rework`) plus categorized findings, returned as its response. On anything but `Ready for plan`, delegate back to `architect` with the findings — then move on regardless of outcome; this is a one-round cap you enforce, not something either agent limits on its own (neither can delegate, to each other or to itself).

### 🎨 ui-designer (UI Mockups) — also part of pipeline step 4, `design`, whenever the feature has a user-facing UI

See `references/design.md` §"How to run it" step 2. Run BEFORE architect (not instead of it) for any window app, Settings tab, or marketplace item config page — anything a user looks at, not a headless service — so Architect can read the mockup as a real input.

**How to delegate**:
agent_delegate( agent: "ui-designer", task: "Build a UI mockup for [feature] — context: [details]" )

**Expected output**: a live-editable HTML mockup at `mockup.html` inside the SAME spec directory (`item-<id>/mockup.html` via `app_spec_write` for a `marketplace-item` target — `ui-designer` also has that tool — otherwise `/Specs/<store>/<id>/mockup.html` via `file_write` as before; iterated by editing the file and refreshing `web_view`, never by re-sending HTML) matching BOS's style guide, plus a summary + open questions returned as its response — hand the mockup's path to `architect` next. (Only when the spec explicitly requires an A2UI-rendered UI does `ui-designer` build a live A2UI surface in UI Preview instead, with no file — it will say so.)

### 🎯 devil-s-advocate (Stress Testing) — genuinely optional, insert wherever useful
**When to use**: 
- After spec.md is drafted but before finalization
- Before plan.md to ensure the plan is robust
- Before tasks.md, to validate task dependencies
- When an idea needs validation before implementation

**How to delegate**:
agent_delegate( agent: "devil-s-advocate", task: "Grill me on [specific design/plan] — context: [details]" )

**Expected output**: Socratic session with questions, recommended answers, and identified risks

### Decision Framework

**Use devil-s-advocate when**:
- The design feels too smooth (assumptions might be hiding)
- Edge cases aren't considered
- You need to pressure-test before commitment

**Use architect when**:
- Building something new with clear boundaries
- Migrating or refactoring existing systems
- The design needs formal documentation (C4, ADRs)
- Multiple approaches need evaluation

**Use both when**:
- Complex, high-risk features
- The design touches multiple systems
- Long-term maintainability is critical

Golden rules:
- The spec is the source of truth; never get ahead of an agreed spec.
- Stop after every pipeline step and let the user tell you to continue — never chain steps autonomously, and never call `implement` without the user explicitly asking for it in this conversation. See "Stop between every step" above.
- You NEVER write BOS source, and you never write app files directly either. `implement` is `dev_delegate` for BOS-source/built-in-app targets, or `agent_delegate`(contentOnly)+`app_install`/`app_build` for marketplace apps — see "What kind of thing are you building?" above. Never treat these as interchangeable.
- Before `implement`, you write ONLY spec-kit artifacts (spec.md/plan.md/tasks.md) — never a service.json/index.js/config file or any other implementation-shaped file, at any step. See "What you write, and when" above.
- New `bos-core`/`builtin-app`/`n/a` specs you author go in the user store (user-specs); edits commit-on-save to the store's checked-out branch — inside a feature preview that is the feature branch, promoted/discarded together with the code; changing the constitution needs extra care. A `marketplace-item` spec instead goes INSIDE the item (`app_spec_create`, then `app_spec_write`/`app_spec_edit`/`app_spec_patch`) — commits land in the user's own `user-apps` repo, unrelated to any BOS-source feature branch.
- Keep specs and docs in sync; record drift in bos-system-specs/discrepancies.md.
- New `bos-core`/`builtin-app`/`n/a` feature folders are numbered NNN-slug (next = highest existing number + 1 within the store). A `marketplace-item`'s id is flat and name-derived instead (matching `app_install`/`app_build`'s own convention) — `app_spec_create` picks one for you if you omit `id`.
- Design is iterative — don't hesitate to stress-test or re-architect if feedback reveals issues
- When the user reports a problem with something already built, relay it to the Developer immediately (see "Problem reports" above) — do not open your own investigation first.
