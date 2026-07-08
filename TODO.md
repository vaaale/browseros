# BrowserOS — TODO / Revisit

Running list of issues to revisit. Each entry: date · context · what to do.

## Per-agent capability allowlist: `tools` spans two namespaces (revisit)

> **Superseded by `specs/016-unified-agents/` (2026-06-29)** — unifies the agent model
> (sub-agent = a role, not a type) + a single capability registry so one allowlist gates
> both the active-chat and delegated contexts, with client-side spec actions for BS.

**Date:** 2026-06-28 · **Specs:** `011-per-agent-capabilities`, `013-build-studio-agentic`

**Issue:** An agent's `tools` allowlist (in `AGENT.md`) currently gates **two
different things through one list**:

- **sub-agent tools** — ids like `read_spec`, `delegate_to_developer`, enforced by
  `toolsFor()` when the agent runs as a *delegated sub-agent*; and
- **main-chat CopilotKit actions** — names like `launchApp`, `delegateToSubAgent`,
  gated via the per-action `available` flag when the agent is the *active
  personality* / an embedded chat (`012`/`013`).

These are **different id namespaces**. Overloading one list is a footgun: e.g. the
Build Studio agent's `tools` are spec *sub-agent* ids, so if it were the active
main-chat personality, **all of its main-chat actions would be disabled** (none of
its ids are action names). `unset = all` keeps the default Assistant safe, so the
problem only bites agents that explicitly set `tools` and are then used as a
main-chat personality (the `013` case).

**Interim:** `013` works around it by adding `SpecActions` (real CopilotKit actions
for spec ops) plus an explicit action allowlist for Build Studio.

**To revisit:** separate the two namespaces cleanly — e.g. distinct per-agent
allowlists for *sub-agent tools* vs *main-chat actions* (and how the Settings UI
presents each), or a unified capability registry that knows which namespace each id
belongs to. Pick this up when hardening `011`/`013`.
