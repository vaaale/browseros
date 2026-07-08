# Settings → Browser Automation

**Browser automation** lets the **assistant** drive a *real* browser to automate
web tasks — navigate, fill forms, click through flows, extract data, take
screenshots. It's delivered through a managed **Playwright MCP** server whose tools
appear to the assistant (and sub‑agents and workflows) like any other tools.

> This is a **higher trust tier** than the [Browser app](../apps/browser.md): the
> Browser app lets *you view* pages through a guarded proxy; automation lets the
> *assistant act* on real pages with a real browser. It is **off by default**.

---

## Fields

- **Enabled** — master switch. Off ⇒ the assistant has no browser‑automation tools.
- **Allowed origins** — origins the browser may visit (comma/space/semicolon
  separated).
- **Blocked origins** — origins to always block.
- **Headless** — run without a visible window (default on).
- **Isolated profile** — use a fresh, in‑memory profile with **no** access to your
  real cookies/sessions (default on).
- **Allow downloads** — default off.
- **Consent** — `No prompt (within allowlist)`, `Ask once per session`, or
  `Ask before each use`.
- **MCP command** — the command used to launch the Playwright MCP server (default
  `npx @playwright/mcp`).

Changing these reconfigures the managed server (no restart needed).

---

## Safety — read this

- **The sandbox is the real security boundary.** The automation browser makes its
  **own** network requests and **bypasses** the in‑app proxy's safety guard. Run
  BOS in a sandbox (e.g. Docker with restricted network egress) for real
  containment.
- **Origin lists are advisory, not a hard boundary.** Per Playwright MCP's own
  documentation, allowed/blocked origins reduce accidental reach but are **not** a
  security boundary. An empty allowlist inherits the server's allow‑all default —
  don't rely on it to deny.
- **Isolated by default** — no access to your saved sessions unless you change it.
- **Untrusted page content.** Anything the browser reads is **data, not
  instructions** — the assistant is told not to follow instructions found on pages.
- **Consent caveat.** Today the **enforced** controls are the master switch, the
  origin filters, and the isolated profile. The per‑use / per‑session **consent
  prompt** is configurable but **not yet enforced** (a known follow‑up).

---

## Requirements

Needs the `@playwright/mcp` package and an installed Chromium
(`npx playwright install chromium`). If no browser is available, the automation
tools simply don't appear (graceful degrade) — never a hard error. BOS reuses the
same Chromium the test suite installs, so there's no extra download.
