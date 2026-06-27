# BrowserOS Self-Testing (Playwright) — Specification

To make self-modification trustworthy and user-friendly, a candidate version MUST be able to **test itself** end-to-end before the user promotes it. This document specifies that: a Playwright-based **verify stage** added to the validation gate of `spec/self-modification/self-modification.md` §4, the dev agent's obligation to author tests and fixtures, agent-driven interactive verification, the configurable promote gate with user override, and how results are surfaced.

It is a companion to `spec/self-modification/self-modification.md` (the control plane) — that document is authoritative for the version lifecycle; this one is authoritative for how a candidate is functionally verified.

The fit is natural: a candidate already boots as a production build on its **own internal port** (§4) against an **isolated data clone** (`spec/self-modification/datafs.md`). Playwright therefore drives the real candidate and may freely create files, send chats, and change settings — **non-destructively**, because every write lands in the throwaway clone, never in production data.

---

## 1. The verify stage in the gate

The validation gate (`self-modification.md` §4) gains a functional stage after the candidate is healthy:

```
building → ready (boot + health) → testing (Playwright) → verified | tests-failed
```

- **`ready`** (booted + `/api/health`) → the candidate is **previewable**. Preview is intentionally NOT blocked on the verify stage, so the user can manually inspect a candidate even to investigate a test failure.
- **`testing`** → the Supervisor runs the Playwright suite against the candidate's URL.
- **`verified`** → all required tests passed (or the stage was skipped via degradation, §2) → promotable with no override.
- **`tests-failed`** → at least one required test failed → promotable only via the configured override (§4).

The **Supervisor** orchestrates the run (it already owns the gate and runs commands; Playwright is a Node process driving a browser, so it runs outside the BOS app, pointed at the candidate's port). Earlier build/health failures remain terminal as before — the verify stage only runs once the candidate is `ready`.

---

## 2. Probe-and-degrade (browser availability)

Playwright requires browser binaries and system dependencies that will not exist on every host (a minimal Docker image, a bare server). Self-testing MUST therefore follow the same **probe-and-degrade** philosophy as the DataFS capability probe:

- At startup (and on demand) the Supervisor MUST **probe whether a usable browser is available** to Playwright.
- If it is **not**, the verify stage is **skipped** with a clear, surfaced status (e.g. "E2E skipped — no browser available"), and the candidate proceeds as `verified-by-fallback` on build+health alone. Self-testing is an **enhancement, never a hard requirement** — a missing browser MUST NOT block self-modification.
- The browser install (`npx playwright install --with-deps` or an equivalent image) is a deliberate setup step. Because it adds a dev dependency and toolchain, it is opt-in at the environment level; BOS detects the result rather than assuming it.

---

## 3. Agent-authored tests and fixtures (mandatory)

The tests are **produced by the developer sub-agent as part of implementing the feature or app** — not maintained as a separate human chore.

- When the Developer implements or modifies a feature/app, it MUST **author Playwright tests covering that change** and MUST **generate the test data / fixtures those tests require**. The agent runs them to green (locally, §5) before reporting the task complete.
- The agent MUST receive **clear, explicit instructions to do this** — encoded in the developer sub-agent's system prompt and in the relevant skills ("Modify BrowserOS" and "Build App", per `spec/bos.md`). A change without accompanying tests is an incomplete change.
- Tests MUST be **self-contained and deterministic**: they set up their own state via the agent-generated fixtures (or the app's own APIs), so they do not depend on ambient user data and produce the same result on every run. Under the full self-modification flow they run against the candidate's isolated data clone; **until DataFS lands, e2e runs against the app's real data dir**, so the suite MUST be written **non-destructively** (this is why self-containment matters today, not only for repeatability).
- **A versioned baseline suite** of OS golden paths (desktop loads, open an app, file browser, settings, the Assistant window) lives in `e2e/` and the agent extends it over time. It runs against a server on `localhost:3000` (`reuseExistingServer` reuses a running dev server, else starts one), targets stable hooks `data-testid="desktop" | "dock" | "dock-<appId>" | "window-<appId>"`, and a **global setup** writes the `setupComplete` flag so the first-run wizard stays closed. The baseline is the regression safety net — especially valuable for catching **SSR/hydration mismatches**, a hazard called out in `docs/DEVELOPMENT.md`.
- **LLM-nondeterminism caveat.** Flows that exercise the assistant hit a real, slow, nondeterministic model. Agent-authored tests MUST keep assertions on deterministic OS/UI behavior and **stub the LLM** for chat flows (assert "message sent / streaming UI appears", not the model's words). The promote gate MUST NOT depend on nondeterministic model output.

---

## 4. Promote gate & override (configurable)

The user always keeps the option to ship. The verify stage gates promote according to a configurable policy, and an override is always available:

- **`gatePolicy` setting** (Settings, see §6):
  - **`block-with-override`** (default) — a `tests-failed` candidate is not promoted by default, but the user MAY **override and promote anyway** through an explicit action that shows a clear warning and the failing results.
  - **`advisory`** — results are shown but never block; promote is always allowed.
- The **override action is always present** (the principle is "keep options open"); the setting governs only whether a confirmation/warning step precedes it, never whether override exists.
- A degraded (skipped) verify stage (§2) does not block promote.

---

## 5. Interactive verification (shell/code execution)

Beyond authoring test files, the developer sub-agent SHOULD be able to **drive a live browser against the running candidate** — to verify its own change and to author the tests in §3. The mechanism is **shell/code execution running Playwright**, not a dedicated browser-tool abstraction:

- The agent writes and runs a Playwright script (or `playwright test`) and has it **emit exactly the observations it needs** — `page.screenshot()`, an accessibility-tree or console dump to stdout, assertions — then reads those back and decides the next step. With a persistent session it can drive a REPL-style, step-by-step loop. This yields action-level interactivity (navigate → observe → act → observe) while remaining ordinary, reproducible code.
- **Eyes on the page.** A screenshot written to disk and read back through the agent's image-capable file read gives the agent a literal view of the rendered candidate — the "eyes on the work" benefit, with no extra browser service.
- It is more flexible than a fixed browser-tool API: the agent can express *any* interaction and *any* observation as code, and what it produces while exploring is the same artifact we keep — the spec file (§3). This is the iterative self-correction loop that lets the agent catch its own breakage before the user ever opens preview.

**How this maps to the harness (per `spec/bos.md`):**
- **Claude CLI harness (default):** the agent already has a shell — its own Bash — so it scripts Playwright and reads screenshots with no additional tooling.
- **Local CopilotKit sub-agents:** provide a **sandboxed code/shell execution tool** (a generalization of the gated, allowlisted `run_command`) so these agents can drive Playwright the same way.
- **Playwright MCP** (`@playwright/mcp`): a **fallback only** *for self-testing*, for a driving model that genuinely cannot execute code; it exposes browser actions as MCP tools, which the shell/code-execution path otherwise subsumes. (Note: MCP is the **primary** mechanism for the separate **browser-automation** feature, where the driver is the shell-less *assistant* — see `spec/automation/browser-automation.md`.)

**Sandbox.** Driving a browser through arbitrary code execution requires a **trusted, sandboxed environment** — already assumed for the dev harness (`--dangerously-skip-permissions`, intended to run in Docker; `spec/self-modification/self-modification.md` §9), so no new risk surface is introduced.

(Deterministic, repeatable verification is the test suite of §3, run as the gate by the Supervisor; interactive exploration is the shell/code-execution loop here — and the exploration produces the durable tests. They are complementary.)

---

## 6. Reporting

Results MUST be **surfaced to the user when implementation and testing complete** — this is the core user-friendliness payoff (a clear pass/fail with evidence instead of manual clicking):

- The Supervisor MUST capture Playwright's artifacts per candidate: pass/fail counts, the HTML report, traces, and **failing-step screenshots/video**.
- A concise result (e.g. "next: 24/25 passed — 1 failure, screenshot attached") MUST be surfaced in the **chat on task completion** and in the **Versions view** (`self-modification.md` §10), with a link to the full report and inline failing screenshots.
- Artifacts SHOULD be retained per candidate (subject to a retention setting) and discarded when the candidate is discarded.

---

## 7. Configuration

A configuration namespace (part of, or alongside, `self-modification` per `spec/self-modification/self-modification.md` §10) MUST expose at least:
- **mode** — `auto` (run the verify stage when a browser is available) or `off`.
- **`gatePolicy`** — `block-with-override` (default) | `advisory` (§4).
- **browser/install** info and the detected-capability read-out (mirrors the DataFS probe transparency).
- **report retention** (how long per-candidate artifacts are kept).

Per the BOS configuration system this also exposes these to the assistant as tools.

---

## 8. Relationship to other specs

- **`spec/self-modification/self-modification.md`** — the verify stage extends its validation gate (§4); promote consults the gate policy here (§6); reports appear in its Versions view (§10).
- **`spec/self-modification/datafs.md`** — the isolated data clone is what makes self-testing non-destructive; the browser-capability probe mirrors the DataFS capability probe.
- **`spec/bos.md`** — the Developer sub-agent and its skills (which MUST instruct the agent to author tests + fixtures), the dev harness's shell execution and the local sub-agents' code-execution tooling (how the agent drives Playwright, §5), the MCP subsystem (the Playwright-MCP fallback), and the configuration system.
- **`spec/self-improvement/self-improvement.md`** — "a change without tests is incomplete" is part of the BOS-codebase development workflow (§8 there).
