# Testing

Related reading: [Architecture overview](./architecture-overview.md) ·
[Style guide](./guides/style-guide.md) · [Deployment](./deployment.md)

| Command | What it runs |
|---|---|
| `npm run test:unit` | The unit suite (`tests/**`, Playwright runner, no browser) |
| `npm run test:supervisor` | The Supervisor suite (`tests/supervisor/*.test.mjs`, `node:test`) |
| `npm run test:coverage` | Both of the above, merged into one report over all of BOS |
| `npm run test:bench` | Performance benchmarks (`tests/benchmarks/`), serial |
| `npm run test:e2e` | Browser e2e (`e2e/**`, real BOS via `playwright.config.ts`) |
| `node --test tests/compaction/` | Compaction tests — `node:test`, not Playwright |
| `npm run validate:methods` | Spec-method layer smoke test against a **running** BOS |

---

## Always run the unit suite through `npm run test:unit`

Not `npx playwright test -c playwright.unit.config.ts`. The npm script sets two
things through `NODE_OPTIONS` that a Playwright config cannot set for itself,
and both are load-bearing:

- **`--conditions=react-server`** — `server-only` throws on import unless
  resolved under this export condition, so without it every test that
  transitively imports a `import "server-only"` module fails the moment the
  file loads, before any test runs.
- **`--require ./tests/_no-external-network.cjs`** — the network guard below.
- **`--require ./tests/_no-live-deployment.cjs`** — the live-deployment guard
  below.

Run it the other way and you get a pile of failures that look like product
bugs and are not.

---

## The unit suite is hermetic: no unit test may reach an external host

`tests/_no-external-network.cjs` is preloaded into every worker and fails any
outbound connection that isn't loopback or a unix socket. Loopback stays open
deliberately — tests spawn real local HTTP servers (`tests/bastion/`) and talk
to `/var/run/docker.sock` (`tests/bastion/image-autobuild.test.ts`).

**This is not hygiene, it's a correctness gate.** Nothing in `src/`
short-circuits a model call when no provider is configured:
`src/lib/agent/llm.ts` builds a client with the literal api key `"MISSING"` and
sends the request anyway. So any test that reaches `runSubAgent` makes a real
HTTP request, and *which service it hits depends on the machine*:

- `data/provider.json` — `src/lib/agent/provider.ts` computes its file path
  from `dataDir()` at **module scope**, before any test redirects
  `BOS_DATA_DIR`, so a developer's real provider config can win;
- otherwise `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` from the ambient
  environment — for anyone running the suite from a shell that has them set,
  the live Anthropic API.

Four self-heal tests were doing exactly this. They passed only because an
external service happened to reject the request quickly, and timed out at 30s
whenever it didn't; with a valid key they would have made real billable model
calls from a unit test. `tests/network-guard.test.ts` asserts the guard is
actually installed, because it is wired through `package.json` and would
otherwise be easy to drop silently.

**If a test needs a model run, stub the seam** — `_setAgentLayerForTests`,
`_setDiagnosticianRunnersForTests`, `_setSpineAgentHooksForTests`. Never widen
the guard. `BOS_TEST_ALLOW_NETWORK=1` exists for a one-off local run, not for
committed tests.

---

## Some bugs only exist at a boundary

`npm run validate:methods` exists because the unit suite — 1562 tests — caught
**none** of the seven defects found the first time the spec-method layer (044–048)
was exercised against a running BOS. Not because coverage was thin. Because each
one lived at a boundary a unit test cannot cross:

| Boundary | The defect |
|---|---|
| install → restart | a pack registered at install and never again; it vanished on reboot |
| module instance | instrumentation's registry is not the one route handlers read |
| parse → rewrite | a field the parser ignored was **deleted from disk** on the next repair |
| seed memoisation | `ensureSeed` had already run, so installing seeded nothing |
| descriptor → message | a warning naming a phase the target method did not have |

A unit test runs in one process, one module instance, one memoised state. The
fixtures installed and asserted in the same breath, so they could never observe
the gap — and each one passed while its feature was broken.

That is a gap in test **topology**, not coverage. When a feature's contract spans
a restart, a second module instance, or a file BOS rewrites, add a check that
crosses that boundary; asserting the same thing harder inside one process will
not find it.

Two related habits the same episode taught:

- **Drive the path the feature uses, not the helper you just wrote.** Three
  defects survived tests that called a listing function directly while the
  product called `getAgent()`.
- **A fixture that stands in for a missing step cannot detect the step is
  missing.** One test proved a pack worked *when installed as an item* while the
  pack was not distributed as one.

## The unit suite is hermetic about the DEPLOYMENT, not just the network

`tests/_no-live-deployment.cjs` is preloaded alongside the network guard. It
clears the deployment coordinates that every Supervisor-managed BOS process
carries in its environment — `BOS_SUPERVISOR_URL`, `BOS_REPO`,
`BOS_WORKTREES`, `BOS_DATA_CLONES` — and then refuses any `/__supervisor/`
request to the origin that was **inherited**.

**Also a correctness gate, also with an incident behind it.** A self-modifying
agent running `npm run test:unit` inside a live BOS inherits that environment,
and `src/lib/devharness/supervisor.ts` gates on nothing but the presence of
`BOS_SUPERVISOR_URL`:

```js
function baseUrl() { return (process.env.BOS_SUPERVISOR_URL || "")… }
export function supervisorEnabled() { return !!baseUrl(); }
```

So `specfs.writeFile({ branch: "bos/history" })` in a unit test POSTs to the
**live** Supervisor's `/__supervisor/begin`, which creates a real branch, a
real worktree and a real data clone. A production box was found carrying 21
`bos/*` branches — 18 of them fixture names straight out of this suite
(`bos/history`, `bos/lifecycle-test`, `bos/project-layer`, `bos/core-change`,
`bos/follow-the-money`, `bos/from-the-picker`, …) — each with a full copy of
the user's 8.5 GB data dir attached. On a developer machine nothing listens on
the control port, so the suite looks perfectly hermetic and the leak only ever
appears in production.

A test that genuinely needs a Supervisor stands up **its own** fake and points
`BOS_SUPERVISOR_URL` at it (`tests/self-heal/integration-partial-build.test.ts`,
`edge-branches.test.ts`). That keeps working: only the inherited origin is
blocked, because a fixture on its own ephemeral port is not a deployment.

`tests/specs/unit-suite-never-reaches-live-supervisor.test.ts` exercises this
from a **child process**, because the bug only exists across the process
boundary the guard is installed at — a same-process assertion runs after the
guard and cannot see it.

> The general rule: `tests/services/_test-env.ts` documents the same shape of
> leak for `BOS_SPECS_ROOT` (~50 stray projects in a live spec store) and
> `BOS_CANONICAL_DATA` (corrupt conversation fixtures in a real data dir).
> **Sandbox every ambient path a test could resolve, not just the one you are
> thinking about.**

## Fixture branches are named `bos/testfixture-…`

Every `bos/…` branch literal in `tests/` and `e2e/` starts with
**`bos/testfixture-`**, and `tests/specs/test-branch-naming.test.ts` fails the
build if one doesn't.

The reason is the same incident as above. Fixtures were named after the real
feature branches the features had been built on — `bos/follow-the-money`,
`bos/agentic-editor-appearance`, `bos/history`, `bos/core-change`,
`bos/project-layer`, `bos/file-tools-contract`. When a test run created them
for real in a live deployment, nothing distinguished a fixture's debris from
somebody's unfinished work, so cleaning up meant reading each branch and
guessing. A reserved prefix makes that a `grep`.

**Mind the length.** `FEATURE_BRANCH_RE` (`src/lib/agent/feature-branch.ts`) is
`/^bos\/[a-z0-9]+(?:-[a-z0-9]+){0,3}$/` — four dash-separated segments, total.
`testfixture` spends one, so a fixture name gets **at most three more**. Shorten
the name rather than adding a segment; a branch that fails the regex is rejected
by `requireFeatureBranch` far from the test that named it.

Two narrow exemptions, both listed with a reason in the enforcement test's
`ALLOWED` map, and nothing else:

- **validation inputs** — `bos/Has-Upper`, `bos/a-b-c-d-e` and friends exist to
  be *rejected* by `isFeatureBranch`; renaming them changes what is under test;
- **product-generated names** — `selfHealBranch(caseId)` returns
  `bos/self-heal-<id>`, so a test asserting that mapping must spell the real
  output.

Comments are deliberately not scanned: prose quoting the real historical branch
names (or a production log line containing one) is evidence, and rewriting it
would destroy the explanation.

## Determinism rules

The unit suite is `fullyParallel` with one worker per core, and **Playwright
reuses a worker process across test files**. Two consequences:

**1. Absolute wall-clock assertions don't belong in it.** A test timed while
~15 other workers compete for CPU measures contention, not code. That is why
`tests/benchmarks/` is excluded from `test:unit` (see
`playwright.unit.config.ts`'s `testIgnore`) and has its own
`playwright.bench.config.ts` with `workers: 1`, where its budgets
(`avgMs < 0.01`, …) are both stable and meaningful.

**2. Process-global state leaks between files.** A test that mutates a
`globalThis` registry and doesn't restore it corrupts whichever file the worker
picks up next — and the failure surfaces in that innocent file, which makes it
very hard to read. Reset helpers must cover *everything* the code under test
writes, not just its own singleton: `resetServiceSingletons()` dropped the
service-tool bridge but left the two registries the bridge populates
(`__bos_dynamic_capabilities__`, `__bos_dynamic_tool_groups__`), which
intermittently failed the ADR-1/R3 migration invariant over in
`tests/agent/tool-groups.test.ts`.

**Don't wait on a window a fixture only holds open briefly.** Signal it
instead. `ServiceManager.test.ts`'s crash fixture used to `process.exit()` on a
50ms timer while the test polled every 10ms for the state that existed inside
that window; under load the tick slipped past it, the window closed unseen, and
the wait could then never succeed. It now exits when the test drops a
`.exit-now` file, so the ordering is guaranteed rather than probable.

Raising a timeout is almost never the fix for either class. If a wait can miss
its condition entirely, a longer wait just fails more slowly.

---

## Coverage

`npm run test:coverage` reports over **all of BOS**: `src/**` (`.ts` + `.tsx`),
`bastion/src/**`, and `tools/supervisor/**`. Config is `.c8rc.json`; output
lands in `coverage/` (gitignored) — `coverage/index.html` for the browsable
report, plus `lcov.info` and `coverage-summary.json` for editors and CI.

It runs **two** suites and merges them:

```
rm -rf coverage                                    # coverage:clean
c8 --no-clean --reporter=none npm run test:unit    # src/** and bastion/src/**
c8 --no-clean --reporter=none npm run test:supervisor   # tools/supervisor/**
c8 report                                          # one merged report
```

The merge is the point, and `--no-clean` is what makes it work: the two suites
have different runners (Playwright for `tests/**/*.test.ts`, `node:test` for
`tests/supervisor/*.test.mjs`), so each writes its raw V8 dumps into the shared
`coverage/tmp/` and the final `c8 report` reads both. **Running only one of
them and reporting would show the other's tree at 0%** — which is precisely the
kind of number a coverage report exists not to produce.

Two things to know about reading it:

- **`all: true` counts files no test ever loads.** A React component the unit
  suite never renders contributes its whole line count to the denominator at 0%.
  That is deliberate: the alternative is a percentage computed only over files
  that happened to be imported, which flatters itself. `.c8rc.json` narrowed to
  nine `src/os` files once reported **99.3%** while ~760 shipped files sat
  outside the report entirely.
- **`tests/compaction/` is not in the run.** It is `node:test` over `.ts` with
  extensionless imports, which does not resolve under `--experimental-strip-types`
  on Node 22; `src/lib/agent/compaction/**` is still *in* the report, credited
  with whatever `test:unit` exercises.

`tests/specs/coverage-scope.test.ts` is the gate: it walks the three source
trees and asserts every file matches `.c8rc.json`'s globs, resolved through
`test-exclude` — the same matcher c8 itself uses, so the test and a real run
cannot disagree. Add a source tree and it fails until the config includes it.

`coverage/tmp/` holds the raw V8 dumps and is large (~160 MB). `coverage:clean`
removes it at the start of every run, so it does not accumulate; keeping it
after a run is what lets you re-run `npx c8 report` without re-running the
suites.

A separate, **enforced** gate exists for one subsystem: `.c8rc.self-heal.json`
requires 95% lines/branches over `src/lib/self-heal/**` — see
[self-healing](./self-healing/self-healing.md). The repo-wide report has no
threshold; it is a map, not a gate.
