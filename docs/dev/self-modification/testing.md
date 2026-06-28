# Self-modification: testing & verification

Spec: `spec/self-modification/testing.md`.

BOS ships an **end‑to‑end** suite so a self‑modification can be verified before it's
trusted.

---

## Playwright e2e (`playwright.config.ts`, `e2e/`)

- `testDir: ./e2e`, `globalSetup: ./e2e/global-setup.ts`, `fullyParallel`, HTML +
  list reporters, traces on first retry, screenshots/video on failure.
- **Browser:** the `chromium` project runs with `channel: "chrome"` (system Chrome),
  since the bundled Chromium isn't downloaded in every environment.
- **Server:** `webServer` runs `npm run dev` at `BASE_URL`
  (`BOS_E2E_BASE_URL` or `http://localhost:3000`) with **`reuseExistingServer:
  true`** — a dev server already on :3000 is reused, else Playwright starts one.

Run: `npm run test:e2e`.

### Current specs

| Spec | Guards |
|---|---|
| `desktop.spec.ts` | desktop renders; **no hydration mismatch** (the SSR/CSR baseline) |
| `no-uncommanded-run.spec.ts` | reopening a chat never resumes an in‑flight turn (`trimToSettledTail`) |
| `card-collapse.spec.ts` | event cards auto‑collapse (timers live outside React) |
| `app-candidate.spec.ts`, `app-candidate-live.spec.ts` | GitFS app candidate preview/promote/discard |
| `app-project-live.spec.ts` | project‑app build + serve |

Treat these as **regression baselines** — when you change the shell, chat
streaming, or the app‑candidate flow, keep them green and add a spec for new
behavior.

---

## Verification expectations for the developer agent

- After a code change: `npx tsc --noEmit` and `npm run lint`; for behavior changes,
  add/extend an e2e spec and run `npm run test:e2e`.
- The repo‑scoped `run_command` dev tool allows exactly `typecheck` / `lint` /
  `build` / `e2e` (`src/lib/dev/run-command.ts`).

---

## Spec gap: the Supervisor verify stage

`testing.md` envisions the Supervisor running a **Playwright verify stage** on a
candidate (states `testing` → `verified` | `tests-failed`, with a captured report
surfaced in the Versions UI). Today the Supervisor health‑gates a candidate only
(`building` → `ready` | `failed`); it does **not** run e2e as a gated stage, and the
`tests-failed` state referenced by the UI is never produced. The e2e suite exists
and is run **manually / by the agent**, not auto‑run on promote. See
`spec/discrepancies.md`.
