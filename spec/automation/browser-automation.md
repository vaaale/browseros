# BrowserOS Browser Automation — Specification

BOS exposes **Playwright-based browser automation to the assistant as a first-class tool**, so the assistant, sub-agents, and workflows can drive a real browser to automate web tasks — navigate, fill forms, click through flows, extract data, take screenshots. This expands the `spec/bos.md` "Agentic behavior and automation" requirement and builds on its first-class MCP support.

It is a **separate feature from self-testing** (`spec/self-modification/testing.md`): same underlying tool (Playwright), but a different driver and a different risk profile. Self-testing is the *developer sub-agent* (which has a shell) verifying a candidate build via the Playwright CLI; automation is the *assistant* (which has **no** shell) acting on the live web via structured tools. They share only the Playwright substrate (browser binaries, the capability probe).

---

## 1. Principles

- **Mechanism = MCP.** The assistant drives the browser through **structured MCP tools**, because it has no shell to run scripts. BOS exposes Playwright via the official **Playwright MCP server** (`@playwright/mcp`) wired into the existing agent runtime — reusing BOS's first-class MCP support rather than building a bespoke browser API. (This is the mirror of the testing decision, where the shell-equipped dev agent uses the CLI and MCP is only a fallback.)
- **Powerful and dangerous → gated and sandboxed by default.** A real browser the assistant can point anywhere is a **higher trust tier** than the user-facing proxy Web Browser. It MUST be governed by explicit, user-configurable policy, disabled until configured, and run sandboxed.
- **Configurable, never hardcoded.** All policy — enablement, host scope, headless, isolation, consent, limits — lives in a **Settings configuration namespace** (which, per the config system, also auto-exposes it to the assistant as tools).
- **Untrusted page content.** Anything the browser reads is **data, not instructions**; the feature MUST guard against prompt injection from automated browsing.

---

## 2. The mechanism: Playwright MCP as a managed server

- BOS runs **`@playwright/mcp`** as a managed MCP server (stdio), wired through the existing MCP runtime (`runtime.ts` + the MCP server store) so its browser tools auto-appear to the assistant, sub-agents, and **workflows**, and in the Tools panel.
- The tools (navigate, click, type, accessibility **snapshot**, **screenshot**, extract, …) are provided and maintained by Playwright MCP; BOS does **not** reimplement them.
- **Session lifecycle.** A browser context is scoped per conversation/automation run, **isolated by default**, and cleaned up on conversation end or timeout. Resource limits (max concurrent contexts, navigation/action timeouts) MUST be enforced.
- **Observability.** Tool calls, snapshots, and screenshots stream into the chat as event cards / MCP-UI (as with other tools), so headless automation is visible to the user as it happens.
- **Browser binary.** `@playwright/mcp`'s `--browser` accepts only `chrome`/`firefox`/`webkit`/`msedge` (not `chromium`); by default it wants a separate `chrome-for-testing` build. BOS instead passes **`--executable-path`** pointing at the Chromium the e2e suite already installed (resolved by the capability probe, §6), so automation reuses one browser with no extra download.
- **stdio argument constraint.** BOS spawns the server over stdio by splitting a single command string on whitespace, so no argument value may contain spaces: origin lists use `;` separators, and the resolved executable path is assumed space-free (a known limitation for paths containing spaces — e.g. some Windows profiles).

---

## 3. Security & gating (MUST)

- **The sandbox is the security boundary.** The Playwright browser makes its **own** network requests and **bypasses the app-level `isBlockedHost()` proxy guard**, so real containment MUST be the execution sandbox (e.g. Docker with a restricted network-egress policy), consistent with the dev-harness posture. A Docker-as-root deployment may also need the server's `--no-sandbox` flag for Chromium to launch.
- **Host scope is advisory defense-in-depth, NOT a boundary.** Per `@playwright/mcp`'s own docs, `--allowed-origins`/`--blocked-origins` *"does not serve as a security boundary and does not affect redirects"*, and the server default is **allow-all**. The origin lists reduce accidental reach but MUST NOT be relied on for security; a true deny-by-default requires the sandbox/network policy above. (BOS passes the origin flags only when the user fills them in, so an empty allowlist inherits the server's allow-all default.)
- **Consent.** A **configurable consent policy** is exposed (`off` | `per-use` | `per-session`). The controls that are actually **enforced** today are the **`enabled` master gate**, the **origin filters**, and the **isolated profile**; `per-use`/`per-session` **elicitation** (interrupting a browser tool call to ask the user, like the Claude-for-non-dev gate in `spec/bos.md`) is configurable but **not yet enforced** — wiring it requires intercepting MCP tool calls and is a known follow-up.
- **Isolation.** An **isolated browser profile by default** (no access to the user's real cookies/sessions/credentials) unless explicitly configured otherwise. Downloads disabled by default.
- **Prompt-injection.** The agent's tool guidance MUST state that extracted page content is untrusted input and must not be followed as instructions.
- **Off by default.** The capability is disabled until the user enables and scopes it.

---

## 4. Configuration (Settings App)

A configuration namespace (e.g. `browser-automation`) MUST be registered so it renders a **Settings tab** and is auto-exposed to the assistant as tools (per the BOS configuration system). It MUST expose at least:

- **enabled** — master on/off (default **off**).
- **allowed origins** / **blocked origins** — best-effort host filtering passed to the MCP server (**not** a security boundary; see §3). The server default is allow-all, so an empty allowlist does **not** deny — rely on the sandbox/network policy for hard containment.
- **headless** — default **true**.
- **isolated profile** — default **true** (vs a persistent profile).
- **consent policy** — `off` | `per-use` | `per-session` (conservative default). Governs intent today; per-use/per-session elicitation enforcement is a follow-up (§3).
- **downloads allowed** — default **false**.
- **limits** — max concurrent browser contexts, navigation/action timeouts.

Changing these reconfigures the managed Playwright MCP server (e.g. its origin flags, headless/isolated mode).

---

## 5. Relationship to the proxy Web Browser app

These are complementary, not duplicative:
- The **Web Browser app** (`spec/bos.md`) is a same-origin, path-based **proxy** for the **user** to *view* pages inside the OS, with the SSRF guard.
- **Browser automation** is a server-side **real** browser for the **assistant** to *act on* pages. Different actor, different trust tier, and contained differently: the proxy relies on `isBlockedHost()`, while automation relies on the **sandbox** (the origin allowlist is only advisory — §3).

---

## 6. Capability probe & degradation

Automation reuses the shared "**is a Playwright browser available?**" probe (also used by self-testing, `spec/self-modification/testing.md`), which also **resolves the installed Chromium binary path** that automation passes via `--executable-path` (§2). If no browser is available, the automation tools are unavailable/disabled with a clear status — never a hard failure.

---

## 7. Exposure surface

- Available to the **main assistant**, **sub-agents**, and **workflows** (browser steps are a natural workflow action), all subject to the gating in §3–§4.
- Mirrored in the Tools panel / tool manifest like other tools and MCP servers.

---

## 8. Relationship to other specs

- **`spec/self-modification/testing.md`** — the same Playwright substrate; testing uses the CLI/shell (dev agent), automation uses MCP (assistant). MCP is the **primary** mechanism here and a **fallback** there.
- **`spec/bos.md`** — the MCP subsystem, the configuration system (a namespace → a Settings tab + assistant tools), the proxy Web Browser app, and sub-agents/workflows.
