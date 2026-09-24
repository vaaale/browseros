# Settings → Browser Automation

**Browser automation** lets the **assistant** drive a *real*, **stateful** browser
to automate web tasks — navigate, fill forms, click through flows, extract data,
take screenshots. The assistant gets a family of `browser_*` tools
(`browser_navigate`, `browser_click`, `browser_type`, `browser_take_screenshot`, …)
that all operate on **one live browser per conversation**: what one tool call
navigates to, the next call can click.

Screenshots (and other files the browser saves) land in your **Files app under
`/Screenshots`** — ready to use in documents — and are also shown to the
assistant so it can see the page it captured.

> This is a **higher trust tier** than the [Browser app](../apps/browser.md): the
> Browser app lets *you view* pages through a guarded proxy; automation lets the
> *assistant act* on real pages with a real browser. It is **off by default**.

---

## Fields

- **Enabled** — master switch. Off ⇒ every browser tool answers with "browser
  automation is off" and points here.
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

Changing these reconfigures the managed browser (no restart needed); the next
browser session starts with the new policy.

## Sessions

The browser stays alive between tool calls (that's what makes multi‑step flows
and logins work) and is cleaned up automatically:

- after **15 minutes idle**, the browser is closed;
- the assistant can end it explicitly with `browser_close`;
- all browsers close when BOS shuts down.

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

Needs the `@playwright/mcp` package and a browser: either the Playwright
Chromium (`npx playwright install chromium`) or a system Google Chrome /
Chromium at its standard location (`npx playwright install chrome` — what the
BOS Docker image ships). If neither is found, the browser tools answer with the
install hint instead of failing silently. BOS reuses whichever browser is
already there, so there's normally no extra download.
