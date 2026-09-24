# AGENTS.md — BrowserOS

BrowserOS (BOS) is a single‑page, server‑side‑rendered "operating system in the browser"
(Next.js App Router + React + Zustand) with an agentic assistant that can operate and
**modify BOS itself**.

This file is the entry point for every coding agent working in this repo. Read it in
full before your first edit. `CLAUDE.md` exists only to point here.

---

## 1. Non‑negotiables

These five rules override convenience, override "it's a small change", and override
your own judgement about scope. If you cannot follow one, stop and say so rather than
working around it.

### 1.1 TDD — the test comes first, always

**Write the failing test before the implementation.** Not after, not "alongside", not
"I'll add coverage at the end".

The loop, per behaviour change:

1. **Red** — write a test that reproduces the bug or asserts the new behaviour, and
   *run it*. It must fail, and it must fail **for the reason you expect**. A test that
   passes before you've written the code is testing nothing; a test that fails with
   `Cannot find module` is not yet a red test.
2. **Green** — write the smallest change that makes it pass.
3. **Refactor** — clean up against §1.3 with the test still green.

Rules that make this real rather than ceremonial:

- **A bug fix starts with a reproduction test.** Reproduce it at the layer the bug
  actually lives at (§1.4), watch it fail, then fix. Shipping a fix whose test was
  written afterwards means you never proved the test can catch the regression.
- **Drive the path the product uses, not the helper you just wrote.** Three real
  defects survived tests that called a listing function directly while the product
  called `getAgent()`. If the feature goes through a route handler, the test goes
  through the route handler.
- **Test the contract, not the implementation.** A test that mirrors the shape of the
  code it tests will pass through any refactor and fail on none of the bugs.
- **When the contract spans a boundary a unit test can't cross — a restart, a second
  module instance, a file BOS rewrites, a seed memoisation — add a check that crosses
  it.** The unit suite once had 1562 tests and caught *none* of the seven defects the
  spec‑method layer shipped with, because every one lived at such a boundary and every
  fixture installed and asserted in the same breath. See
  [`docs/dev/testing.md`](docs/dev/testing.md) § "Some bugs only exist at a boundary".
- **A fixture that stands in for a missing step cannot detect that the step is
  missing.**

Where tests go and how to run them: §3.

### 1.2 Workarounds are illegal

**Fix root causes. Never paper over a symptom.** This is the single most repeated rule
in this project.

Banned as "fixes": periodic restarts or recycling to survive a leak, retry loops around
a broken call, `--no-verify`, feature flags that route around a bug, fallback paths that
hide a failure, and above all **swallowed exceptions**.

- **`.catch(() => {})` and bare `catch {}` are banned outright — do not write them.**
  `eslint.config.mjs` enforces this via `no-restricted-syntax`, with a `BASELINE` list
  of the files that already violated it when the rule landed. **Never add a file to
  `BASELINE`** — that is the one move the rule exists to prevent. Note that baselined
  files are *unprotected*, so a swallow written into one of them will not be caught by
  lint and must be caught by you.
- Before writing any `catch`, decide which of two things it is:
  - **An expected absence** (file not found, no such project) → test for that specific
    condition (`err.code === "ENOENT"`) and let everything else propagate.
    `catch { return null }` also reports JSON parse errors, permission errors and disk
    errors as "absent".
  - **A failure** → log it *with its cause* and surface it to the caller, unless
    continuing is a deliberate containment decision that is itself documented.
- **Logging alone is not enough for critical or irreversible steps.** A failure in
  branch deletion, worktree removal, or a spec/user‑apps merge must reach the caller's
  result or throw. The supervisor's `promote()` returned `{ ok: true }` regardless of
  its git failures, and silently left every promote half‑finished on the production box
  for weeks.
- **The worst case is a swallowed error that yields a plausible value.**
  `projectUnitCount(...).catch(() => 0)` tells the user "this removes 0 specs" when the
  count merely failed — so they confirm deleting 30.

Not workarounds, so don't over‑apply the rule: using a supported alternative path that
already exists in the codebase; real fault tolerance at a system boundary (container
memory limits, healthchecks, supervising a crashed process) — as long as it isn't
standing in for fixing a known defect.

**If you can't find the root cause yet, say so plainly** rather than shipping a
mitigation.

### 1.3 SOLID, and the best practice that fits

Every file you touch must leave in better shape than you found it, measured against
SOLID. BOS is a layered system (§4) and these principles have concrete meanings here —
apply them as written, not as slogans.

| Principle | What it means in BOS |
|---|---|
| **S**ingle responsibility | One module, one reason to change. API routes under `src/app/api/**/route.ts` are **thin delegates** — validation and dispatch only; the logic belongs in a `src/lib/<area>/` module that is testable without a `NextRequest`. A route that grew business logic is a refactor, not a precedent. |
| **O**pen/closed | Extend through the registries that exist; don't add a branch to a switch. New settings tab → a `ConfigRegistration` in `src/lib/config/registry.ts`. New installable content → a **facet** of the Item model + a case in the one shared scanner. New built‑in app → a self‑describing folder under `src/apps/<id>/`, auto‑discovered. New tool → the one registry in `src/lib/assistant/registry.ts`. If extending cleanly requires a second registry, you have found a design bug — report it, don't fork the mechanism. |
| **L**iskov substitution | Two implementations behind one contract must be honestly interchangeable. `src/lib/dev/spec-fs.ts` and `src/os/fs/spec-fs.ts` are separate implementations of the same branch‑coupled routing and `writable` gate, and **must be kept in sync**; a divergence there is a security hole, not a quirk. |
| **I**nterface segregation | Keep the narrow, framework‑free contracts narrow. `src/os/types.ts` and the `*/types.ts` files are importable from both server and client **on purpose** — never widen one with a Node or React dependency to save an import. |
| **D**ependency inversion | Depend on seams, not concretions. Server‑only code sits behind API routes and is reached over `fetch`; model calls go through seams that tests replace (`_setAgentLayerForTests`, `_setDiagnosticianRunnersForTests`, `_setSpineAgentHooksForTests`). **If something is hard to test, that is a design signal — fix the design, don't widen the test harness.** |

Alongside SOLID:

- **One mechanism per concept.** BOS has exactly one install mechanism, one tool
  registry, one structural spec‑edit function (`applyWorkflowEdit`). Adding a parallel
  path is the failure mode this codebase has been burned by most.
- **Atomic writes everywhere under `data/`** — `writeFileAtomic` (temp + rename). This
  is the contract that makes DataFS hardlink isolation and crash‑safety work.
- **`data/` schema changes must be backward‑compatible.** The Supervisor shares one
  canonical `data/` across versions and promote is code‑only, so older code may read
  your new data. Migrate forward‑compatibly.
- **Don't duplicate; don't abstract prematurely.** Two call sites is a pattern, not yet
  an abstraction; three is. But copy‑pasting a *policy* — a gate, a path resolution, a
  validation — is never acceptable at any count.
- `docs/dev/design-heuristics.md` is the rest of this list — hard‑won rules baked into
  the code. **Read it before your first non‑trivial change.**

### 1.4 Diagnose where the symptom actually is

- **"The UI shows X" is a claim about the render path, not about the data.** Open the
  component that draws the pixels *before* investigating any server code. Five rounds
  were once spent fixing a correct server because one line of JSX painted a global
  where the question was per‑row.
- **Read the actual run before theorising.** Conversations are
  `data/vfs/Documents/Chats/*.json` — `messages[].toolCalls[].function.arguments` gives
  the exact arguments the agent sent. Supervisor decisions are in
  `data/logs/timeline-<date>.jsonl`.
- **When attribution is hard, instrument rather than reason.** Verify your trap fires
  before asking the user to reproduce.

### 1.5 Leave the documentation true

When you add, change, or remove a feature, in the **same change**:

1. Update the relevant pages under `docs/dev/` and `docs/usage/` (the in‑OS Docs app
   renders these trees directly — there is no separate runtime copy).
2. If the architecture changed, update the spec in the system store
   (`bos-system-specs/…`) via Build Studio.
3. If the thing you changed is an **installed marketplace item**, its docs do *not*
   belong here — they live inside the item (`<item>/docs/usage/<Name>/`,
   `<item>/docs/dev/<Name>/`) and are overlaid onto these trees at read time. When a
   feature moves out of BOS core into an item, **delete its pages here in the same
   change**; two copies is the failure mode, not a safety net.
4. Update this file if you changed something it asserts.

---

## 2. The working loop

```
git checkout -b bos/<short-name>     # never work on claude or main directly
  ↓
write the failing test, run it, watch it fail for the right reason   (§1.1)
  ↓
implement the smallest change that goes green
  ↓
npm run test:unit                    # the whole suite, not just your file
npx tsc --noEmit
npm run lint
  ↓
update docs + spec                   (§1.5)
  ↓
commit
```

- Make **focused** edits. **Don't** touch secrets, `package.json`, lockfiles, or build
  config unless that is the task.
- `src/` hot‑reloads under `npm run dev`. **Never run `npm run build` while `next dev`
  is running** — they share `.next`.
- Fix what you broke: a lint or type error you introduced is part of your change, not a
  pre‑existing condition.
- Commit or stash before starting the Supervisor — it resets uncommitted work. Its
  `tools/supervisor/lib/*.mjs` does not hot‑reload.

### Branches and releases

`claude` is the primary development branch and **keeps its full granular history**.
`main` is the released branch (pushed to both `origin` and public GitHub) and carries
**one squashed commit per release**, tagged `vN.N`. The release cycle is three steps and
the third is the one people forget:

1. `git checkout main && git merge --squash -X theirs claude` → resolve, update
   `CHANGELOG.md` + `RELEASE-NOTES.md`, commit, tag, push both remotes.
2. `git checkout claude && git merge main` → resolve, commit, `git push origin claude`
   (normal push, **never force**).
3. Step 2 is what makes the release commit an ancestor of `claude` so the next
   merge‑base is correct. Skipping it replays the whole branch next time and re‑adds
   files `claude` deliberately deleted.

**Never `git reset --hard main` on `claude`.** `-X theirs` only resolves overlapping
text hunks — it does not handle modify/delete or one‑sided adds, so after any such merge,
diff against `claude` and expect leftovers to resolve by hand.

---

## 3. Testing

Full reference: **[`docs/dev/testing.md`](docs/dev/testing.md)** — read it before
writing your first test. The essentials:

| Command | What it runs |
|---|---|
| `npm run test:unit` | The unit suite (`tests/**`, Playwright runner, no browser) |
| `npm run test:supervisor` | The Supervisor suite (`tests/supervisor/*.test.mjs`, `node:test`) |
| `npm run test:coverage` | Both of the above, merged into one c8 report over **all** of BOS (`src/**`, `bastion/src/**`, `tools/supervisor/**`) → `coverage/index.html` |
| `npm run test:bench` | Performance benchmarks (`tests/benchmarks/`), serial, `workers: 1` |
| `npm run test:e2e` | Browser e2e (`e2e/**`, real BOS via `playwright.config.ts`) |
| `node --test tests/compaction/` | Compaction tests — `node:test`, not Playwright |
| `npm run validate:methods` | Spec‑method layer smoke test against a **running** BOS |

Run a single file: `npm run test:unit -- tests/specs/<file>.test.ts`.

**Never run `npx playwright test -c playwright.unit.config.ts` directly.** The npm
script sets two load‑bearing things through `NODE_OPTIONS` that a Playwright config
cannot set for itself — `--conditions=react-server` (without it, every test importing a
`import "server-only"` module throws before a single test runs) and the network guard
below. Running it the other way produces a pile of failures that look like product bugs
and are not.

**The unit suite is hermetic — no unit test may reach an external host, and
none may address the deployment it is running inside.**
`tests/_no-live-deployment.cjs` clears `BOS_SUPERVISOR_URL`/`BOS_REPO`/
`BOS_WORKTREES`/`BOS_DATA_CLONES` and blocks `/__supervisor/` calls to the
inherited origin. Without it, `npm run test:unit` run inside a live BOS creates
**real** `bos/*` branches, worktrees and data clones through the running
Supervisor — 18 fixture-named branches and their full data-dir clones were
found on a production box this way. Sandbox every ambient path a test can
resolve, not just the one you are thinking about.
`tests/_no-external-network.cjs` is preloaded into every worker and fails any
non‑loopback egress (loopback stays open deliberately: tests spawn real local HTTP
servers and talk to the docker socket). This is a correctness gate, not hygiene: nothing
in `src/` short‑circuits a model call when no provider is configured
(`src/lib/agent/llm.ts` sends the request with the api key `"MISSING"`), so a test
reaching `runSubAgent` makes a **real, billable** request to whatever the machine happens
to be pointed at. **If a test needs a model run, stub the seam.** Never widen the guard;
`BOS_TEST_ALLOW_NETWORK=1` is for a one‑off local run, not for committed tests.

**Determinism.** The suite is `fullyParallel` and Playwright reuses worker processes
across files, so: no absolute wall‑clock assertions (those belong in `tests/benchmarks/`,
which has the machine to itself), and any test that mutates process‑global state must
reset **everything** it writes — not just its own singleton — or it corrupts an innocent
file that runs next, where the failure then surfaces. Don't poll for a window a fixture
holds open briefly; have the fixture signal instead. Raising a timeout is almost never
the fix for either class.

**Test placement.**

- Unit tests mirror the subsystem: `tests/<area>/<name>.test.ts` (`agent`, `apps`,
  `assistant`, `bastion`, `build-studio`, `datafs`, `events`, `gitops`, `logging`,
  `scheduler`, `self-heal`, `services`, `specs`, `supervisor`).
- **A fixture branch is named `bos/testfixture-<name>`** and nothing else —
  enforced by `tests/specs/test-branch-naming.test.ts`. Fixtures named after real
  feature branches became indistinguishable from real work once a test run
  created them for real. `FEATURE_BRANCH_RE` caps a branch at four dash-separated
  segments and the prefix spends one, so the name gets at most three.
- **E2E tests must bundle their own fixtures.** Never assume a seeded spec store, an
  installed marketplace item, or any other gitignored state exists — `data/` is empty on
  a fresh checkout, and a test that depends on local seeding fails in a way that looks
  like a product bug. Write what you need at run time via the API (e.g. `PUT /api/specs`
  to a test‑owned path under the writable `user-specs` store) and never point a test at
  a system path like `bos-system-specs/...`.
- **A marketplace item's e2e belongs in that item's own repo**, under
  `items/<id>/e2e/` with its own `playwright.config.ts` — not in BOS's `e2e/`. BOS's
  suite covers BOS itself: the desktop shell, the assistant, the VFS, Build Studio.

**Convention worth copying:** the strongest tests in this repo open with a comment block
stating the reproduction, quoting the offending code, and naming the command to run it —
see `tests/specs/new-app-in-marketplace.test.ts`. A test that explains the bug it caught
survives the refactor that would otherwise delete it as mysterious.

---

## 4. Architecture orientation

**Before changing anything, read
[`docs/dev/architecture-overview.md`](docs/dev/architecture-overview.md)** — the full
subsystem inventory, dependency graph, and layering. The condensed map:

- **Server‑only code** (`import "server-only"`, Node/`fs`/secrets) lives behind
  `src/app/api/**/route.ts`; clients talk over `fetch`. `src/os/types.ts` is
  framework‑free. Client components start with `"use client"`.
- **The VFS (`data/vfs`, via `src/os/vfs.ts`) is the user's sandbox — NOT BOS source.**
  Edit `src/` to change BOS. File tools and the Files app see only `data/vfs`; BOS source
  is reached through the repo‑scoped dev tools, jailed by `src/lib/dev/repo-fs.ts`.
- **OS state:** `src/store/os-store.ts` (+ `os-provider.tsx`), SSR‑seeded in
  `src/app/page.tsx`. The first client render must match the server markup —
  `desktop.spec.ts` fails on hydration mismatch and is a deliberate tripwire.
- **All runtime state persists as files under `./data`** (gitignored).

### Apps and the Item model

A built‑in app is a self‑describing folder `src/apps/<id>/` (`manifest.ts` +
`index.tsx`), auto‑discovered by `tools/gen-apps.mjs` — there is no central registry
(`src/os/apps.ts` and `src/components/apps/registry.tsx` are thin shims over the
generated lists). Apps are served as an iframe by `src/app/apps/[...slug]/route.ts`.

An **installed** app is one facet of an **Item** — a folder with optional facets `app/`,
`services/`, `plugin/`, `hooks/`, `config/`, `spec/`, `doc/`. Installing creates **one
symlink**, `data/system/<id>` → the item wherever it lives (a marketplace clone or
`data/user-apps/items/<id>/`); it copies nothing, uninstalling is one `rm`, and facets
are found by a depth‑2 scan through that link via the single shared scanner
`src/system/items/installed.ts` (035‑install‑by‑symlink).

`data/user-apps/` is the user's own private marketplace — the same layout as any
marketplace clone (`marketplace.json` + `items/<id>/`), so one repo can serve as either.
BOS maintains that manifest **by merge only, never by regeneration**
(034‑user‑apps‑marketplace‑parity).

> There must be exactly **one** install mechanism. When adding a new installable content
> type, extend the facet model (a new facet directory + a case in the shared scanner) —
> never a separate store, directory, or registry. `appsDir()`/`BOS_APPS_DIR` and
> `data/bos-plugins/` were exactly such parallel paths and are dead architecture: if they
> resurface from an old branch or a stale doc, remove them, don't restore them.

### Assistant

**Server‑owned runs (v2).** The agent loop lives on the server (`src/lib/assistant/`:
`run-manager.ts`, `agent-loop.ts`, `model-turn.ts`, `start-run.ts`); browsers attach to
an NDJSON event stream and execute frontend tools. Tools live in one registry
(`src/lib/assistant/registry.ts` + `tools/server/*` for server tools;
`tools/frontend-declarations.ts` + `components/agent/v2/FrontendToolsV2.tsx` for client
tools). **Default to a server tool.** A frontend tool is dispatched to an attached
browser, so `headlessGate` strips it from every headless run — declare one only for
work that genuinely needs a browser (a window, the wallpaper, a preview). **All
`file_*` tools are server tools; a VFS tool is never a frontend tool** — see
[file tools](docs/dev/file-tools/file-tools.md). Interception via `hooks.ts`. UI is
`src/components/agent/v2/`. Instructions =
active agent + memory + skills (`instructions.ts`). Design/plan:
`docs/plans/2026-07-11-assistant-v2-server-runs.md`. CopilotKit is retired from the chat
path and remains only as a markdown renderer.

Delegation has two mutually exclusive mechanisms — `dev_delegate` (hardcodes
`contentOnly: false`, so a BOS‑source worktree) for `bos-core`/`builtin-app` work, and
`agent_delegate` with `contentOnly: true` (no worktree) for marketplace‑item work. The
distinction is the **worktree type**, not the branch.

### Specs, spec stores, and method packs

Specifications live in **external spec stores** (018), not the source tree: independent
git repos under `BOS_SPECS_ROOT` (default `/specs`, gitignored; seeded on first run from
`seed/spec-store/`) — a BOS‑owned system store `bos-system-specs` and a user store
`user-specs`.

Each store is organized into **Projects** (037), `<store>/<project-id>/...`, with
arbitrary plain sub‑folders below a Project. A directory is a **feature leaf** iff it
directly contains `spec.md`; feature numbering (`NNN-slug`) resets per Project; a Project
is a pure organizational folder with no git‑activation of its own.

- **`bos-system-specs` is read‑only** — the specs BOS ships with, never edited directly
  by agent or human.
- A real customization to BOS core (including built‑in apps) is written to
  **`user-specs`**, editable only on a real `bos/*` feature branch — the *same* branch
  used for BOS's own source, picked via the assistant chat's "Active feature branch"
  dropdown (reused as‑is; there is no separate Build Studio picker).
- Core requirements: `bos-system-specs/core-platform/000-browseros-core/spec.md`.
  Project principles: the spec‑kit **constitution** at
  `bos-system-specs/.specify/memory/constitution.md` (store root, outside any Project).
- Feature specs use `<store>/<project-id>/<NNN-feature>/` and are authored via the
  **Build Studio** app/agent.

**Spec frameworks are method packs** (045/046): the pipeline is *data* — phases,
sections, leaf markers, artifact order — and spec‑kit ships as one pack at
`seed/method-packs/spec-kit/` (descriptor + templates + its four process agents + the
driver skill), mounted at `/Methods/spec-kit/templates`. **`.specify/` no longer exists
in the source tree.**

A pack's pipeline is changed in one of two ways (051):

| | **Overlay** — `data/method-packs/<id>/` | **Fork** — `data/workflows/<id>/` |
|---|---|---|
| What it is | shadows one FILE of an installed pack (a prompt, a template) | a NEW NAMED workflow with its own structure |
| Scope | everywhere that pack is used | bound per store or Project via `spec-store.json`'s `workflow` (supersedes `method`) |
| Upstream | keeps receiving improvements | receives nothing |
| | **reach for this first** | |

Structural edits go through **one** function — `applyWorkflowEdit` in
`src/lib/specs/method/authoring.ts` — behind both the Build Studio canvas
(`PATCH /api/workflows`) and the agent's `workflow_edit`. See
[`docs/dev/method-packs.md`](docs/dev/method-packs.md).

### Configuration

Settings tabs are pluggable config namespaces (`src/lib/config/registry.ts`) — adding one
also exposes it to the assistant. Mark secrets `secret: true`.

---

## 5. Documentation map

The code is the source of truth; these pages explain it. `docs/usage/` is for end users,
`docs/dev/` is for you.

**Start here**
- [Architecture overview](docs/dev/architecture-overview.md) — subsystem inventory,
  dependency graph, layering
- [Design heuristics & gotchas](docs/dev/design-heuristics.md) — the rules violating
  which is how BOS breaks subtly
- [Repository & data layout](docs/dev/repository-and-data-layout.md)
- [Extending BOS](docs/dev/extending-bos.md) — copy‑the‑pattern recipes
- [Testing](docs/dev/testing.md) · [API reference](docs/dev/api-reference.md)

**OS shell** — [window manager & store](docs/dev/os-shell/window-manager-and-store.md) ·
[VFS](docs/dev/os-shell/virtual-file-system.md) ·
[settings & wallpaper](docs/dev/os-shell/settings-and-wallpaper.md)

**Apps & items** — [Apps guide](docs/dev/guides/apps.md) ·
[built‑in](docs/dev/apps/built-in-apps.md) · [installed](docs/dev/apps/installed-apps.md) ·
[marketplace app](docs/dev/apps/marketplace-app.md) ·
[file handlers](docs/dev/apps/file-handlers.md) ·
[service daemons](docs/dev/apps/services.md) ·
[plugin pipeline](docs/dev/plugins/plugin-pipeline.md)

**Assistant** — [overview](docs/dev/assistant/overview.md) ·
[actions & tools](docs/dev/assistant/actions-and-tools.md) ·
[file tools](docs/dev/file-tools/file-tools.md) ·
[sub‑agents & delegation](docs/dev/assistant/sub-agents-and-delegation.md) ·
[broker](docs/dev/assistant/assistant-broker.md) ·
[API](docs/dev/assistant/api/assistant-api.md) ·
[context compaction research](docs/dev/assistant/context-compaction-research.md)

**Specs & methods** — [Build Studio](docs/dev/build-studio.md) ·
[method packs](docs/dev/method-packs.md)

**Agent capabilities** — [memory](docs/dev/memory/memory.md) ·
[self‑improvement](docs/dev/self-improvement/self-improvement.md) ·
[self‑healing](docs/dev/self-healing/self-healing.md) ·
[MCP](docs/dev/mcp/mcp.md) ·
[browser automation](docs/dev/automation/browser-automation.md) ·
[scheduler concurrency](docs/dev/automation/scheduler-concurrency.md) ·
[run‑command](docs/dev/run-command/run-command.md) ·
[web proxy](docs/dev/web-proxy/web-proxy.md) ·
[integrations](docs/dev/integrations.md)

**Self‑modification** — [live version control](docs/dev/self-modification/live-version-control.md) ·
[DataFS data isolation](docs/dev/self-modification/data-isolation-datafs.md) ·
[self‑modification testing](docs/dev/self-modification/testing.md)

**Platform** — [configuration system](docs/dev/configuration/configuration-system.md) ·
[events & notifications](docs/dev/events/events.md) ·
[git conflict resolution](docs/dev/features/git-conflict-resolution.md) ·
[headless client auth](docs/dev/features/headless-client-auth.md) ·
[scratchpad](docs/dev/features/scratchpad.md) ·
[voice mode](docs/dev/features/voice-mode.md) ·
[deployment](docs/dev/deployment.md) ·
[external git repos](docs/git-external-repos.md)

**UI** — [style guide](docs/dev/guides/style-guide.md) ·
[features & components guide](docs/dev/guides/features-and-components.md) ·
[design system](docs/dev/style-guide/README.md)

**Plans** (design records for in‑flight work) — `docs/plans/`.
**User‑facing docs** — [`docs/usage/`](docs/usage/introduction.md), index at
[`docs/README.md`](docs/README.md).

---

## 6. Common locations

| Thing | Where |
|---|---|
| Built‑in app | `src/apps/<id>/{manifest.ts,index.tsx}` (auto‑discovered) |
| Settings tabs | `src/components/apps/settings/` + `src/apps/settings/index.tsx` (entry) |
| Settings → Skills | `SkillsTab.tsx` + `src/lib/agent/skills/store.ts` + `src/app/api/skills/route.ts` |
| Config namespaces | `src/lib/config/registry.ts` |
| Assistant runtime | `src/lib/assistant/` (`run-manager.ts`, `agent-loop.ts`, `model-turn.ts`, `start-run.ts`) |
| Tool registry | `src/lib/assistant/registry.ts`, `tools/server/*`, `tools/frontend-declarations.ts` |
| VFS `file_*` tools | `src/lib/assistant/tools/server/files.ts` (all eleven, server-side) |
| Sub‑agents / delegation | `src/lib/agent/subagents/` + `src/lib/assistant/inner-loop.ts`, `delegation-gate.ts` |
| Build Studio app | `src/apps/build-studio/` |
| Spec server logic | `src/lib/specs/` (`stores.ts`, `store-git.ts`, `seed.ts`, `projects.ts`, `pipeline.ts`, `create.ts`) |
| Spec filesystems | `src/lib/dev/spec-fs.ts` (Build Studio) **and** `src/os/fs/spec-fs.ts` (VFS `/Specs/`) — keep in sync |
| Spec API / store config | `src/app/api/specs/route.ts` · `src/os/specs-dir.ts` |
| Build Studio agent | seeded from `seed/agents/` |
| Driver skill + 4 process agents | pack content under `seed/method-packs/spec-kit/` — agents discovered from the pack root in place, skills copied into `data/skills/` by `skills/store.ts` (installed ITEMS' skills are instead symlinked read-only through `data/system/<id>` — see `bundledAssets.ts`) |
| Item install | `src/system/items/installed.ts`, `src/system/marketplace/install/symlinkManager.ts` |
| Dev harness | `src/lib/devharness/`, `src/lib/dev/repo-fs.ts` |
| Events | `src/lib/events/` + `src/apps/event-viewer/` |

---

## 7. Multi‑user Docker deployment (`bastion/`)

- `bastion/` is a standalone Node.js/Express sub‑project with its own `package.json` and
  `tsconfig.json`. **Do not `npm install` in it** unless you intend to modify bastion
  dependencies.
- `Dockerfile` (repo root) + `docker-entrypoint.sh` build BOS as an image exposing port
  **8090** (the Supervisor). The entrypoint runs `npm install` if `node_modules` is
  absent, supporting per‑user named volumes.
- `BOS_DATA_DIR` (`src/os/data-dir.ts`) — the bastion sets this to `/app/data` in each
  user's container.
- `docker-compose.yml` — bastion + `bos-net` bridge; user BOS containers are spawned at
  runtime via dockerode, never defined in Compose.
  `docker-compose.keycloak.yml` adds a Keycloak OIDC service with a pre‑seeded `bos` realm.
- Guide: [`docs/dev/deployment.md`](docs/dev/deployment.md).
