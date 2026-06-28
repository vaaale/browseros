# Browser automation

Spec: `spec/automation/browser-automation.md`. User‑facing:
`docs/usage/settings/browser-automation.md`.

Lets the assistant drive a **real browser** via a managed **Playwright MCP** server.
Off by default; a higher trust tier than the [web proxy](../web-proxy/web-proxy.md).

---

## Config (`browser-automation` namespace)

Generic config namespace (`data/config/browser-automation.json`), fields:

| key | type | default | meaning |
|---|---|---|---|
| `enabled` | boolean | false | master switch |
| `allowedOrigins` | textarea | — | origins the browser may visit |
| `blockedOrigins` | textarea | — | always‑blocked origins |
| `headless` | boolean | true | run without a window |
| `isolated` | boolean | true | fresh in‑memory profile (no real cookies/sessions) |
| `allowDownloads` | boolean | false | permit downloads |
| `consent` | select | `none` | `none` \| `session` \| `always` |
| `mcpCommand` | text | `npx @playwright/mcp` | launcher |

---

## Managed server (`src/lib/automation/playwright-mcp.ts`)

Builds the Playwright MCP `McpServerConfig` (stdio) from the namespace — translating
`headless`/`isolated`/origin lists/downloads into Playwright MCP CLI flags — and
exposes whether it's enabled. `buildRuntimeOptions()` includes it so its
`browser_*` tools appear to the assistant, sub‑agents, and workflow `tool` steps.

## Availability probe (`src/lib/playwright/probe.ts`)

Shared probe: is a Chromium available? If not, the automation tools simply **don't
appear** (graceful degrade) — never a hard error. BOS reuses the same Chromium the
e2e suite installs (`npx playwright install chromium`).

---

## Security model (read carefully)

- **The sandbox is the real boundary.** The automation browser makes its **own**
  network requests and **bypasses** the proxy's `isBlockedHost` SSRF guard
  ([web proxy](../web-proxy/web-proxy.md)). Real containment = run BOS sandboxed
  (e.g. Docker with restricted egress).
- **Origin lists are advisory.** Per Playwright MCP docs they are **not** a security
  boundary; an empty allowlist inherits the upstream allow‑all default.
- **Isolated profile by default** — no access to real sessions.
- **Untrusted content = data, not instructions** — the agent is told not to obey
  instructions found in page content.

### Known gap

The `consent` setting (per‑use / per‑session elicitation) is **persisted but not
yet enforced** — the enforced controls today are the master switch, origin filters,
and the isolated profile. Tracked in `spec/discrepancies.md`.
