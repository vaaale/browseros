# Browser automation

Spec: `specs/004-browser-automation/spec.md` (v2 redesign described here).
User‑facing: `docs/usage/settings/browser-automation.md`.

Lets the assistant drive a **real, stateful browser** — one live headless
Chromium per (conversation, agent), held open across tool calls — via a managed
**Playwright MCP** server. Off by default; a higher trust tier than the
[web proxy](../web-proxy/web-proxy.md).

Use cases: click‑through web flows, scraping, and screenshotting pages (including
BOS itself) into the VFS for documentation.

---

## Architecture (v2)

Three layers, replacing the v1 wiring that only reached the retired CopilotKit
route (the v2 assistant never saw a browser tool — the defect that motivated the
redesign):

1. **Config + probe → server spec** — `src/lib/automation/playwright-mcp.ts`
   (`getBrowserAutomationStatus()`): reads the `browser-automation` namespace,
   probes for a Chromium build, and builds the stdio `McpServerConfig`
   (structured `command` + `args`, so paths with spaces are safe) with
   `--output-dir` pointed at the VFS `/Screenshots` folder and
   `--output-mode stdout`.
2. **Stateful sessions** — `src/lib/automation/browser-session.ts`
   (`callBrowserTool(sessionKey, tool, args)`): ONE persistent MCP client
   (= one `@playwright/mcp` process = one browser) per session key, mirroring
   run‑command's sandbox‑container registry — `globalThis` maps (hot‑reload
   safe), in‑flight connect dedup, a 15‑minute idle reaper
   (`BROWSER_SESSION_TTL_MS`), shutdown hooks. A transport‑level failure drops
   the session so the next call reconnects instead of wedging. Test seam:
   `_setBrowserSessionHooksForTests`.
3. **First‑class registry tools** — `src/lib/assistant/tools/server/browser.ts`:
   curated `browser_*` server tools (navigate, snapshot, click, type, fill_form,
   press_key, hover, select_option, handle_dialog, wait_for, evaluate,
   take_screenshot, console_messages, resize, tabs, close) in the ONE tool
   registry, keyed on `${conversationId}:${agentId}` — so they reach the chat,
   sub‑agents, and headless runs. Capability entries live in
   `capabilities-registry.ts` (group `web`); the seed assistant allowlists them
   and `backfillBrowserTools()` (subagents/store.ts) grants them once to
   pre‑existing installs.

Gating is at **execute time**, like `run_command`: the tools are always
registered; disabled ⇒ an in‑band error naming Settings → Browser Automation;
no Chromium ⇒ the probe's install hint. Legacy: `getBrowserAutomationServer()`
still feeds `buildRuntimeOptions()` for the retired CopilotKit route only.

### Interaction model

Element targeting uses `@playwright/mcp`'s accessibility snapshots: tools return
a yaml tree with element refs (`[ref=e12]`) that click/type target. This is why
the engine stays the Playwright MCP server rather than the raw Playwright
library — the snapshot/ref model, its maintenance, and subprocess isolation
(a crashed Chromium can't take the Next.js server down) come with it.

### Version quirks the integration papers over (pinned `@playwright/mcp` 0.0.76)

- Action tools answer with a **link to a snapshot .yml file**, not inline refs —
  so the tool layer follows every page‑changing call with a `browser_snapshot`
  and appends its inline yaml (`FOLLOW_WITH_SNAPSHOT`).
- A relative screenshot `filename` resolves against the **server process cwd**,
  escaping the output dir — the session layer refuses traversal and absolutizes
  into `/Screenshots` (creating parent folders; the server doesn't).
- Saved files are referenced by host path, sometimes cwd‑relative — the tool
  layer rewrites both spellings to the VFS path.

### Screenshots

Files land in `dataDir()/vfs/Screenshots` (`SCREENSHOTS_VFS_DIR`), visible in the
Files app and to every `file_*` tool; the image also returns to the model as a
vision attachment (`ToolExecuteResult.attachments`, ≤ 5 MB), so it can see what
it captured. Named screenshots (`filename: "docs/shot.png"`) give deterministic
paths for documentation work.

## Availability probe (`src/lib/playwright/probe.ts`)

Shared probe: is a Chromium available? Knows both install layouts — pre‑CfT
(`chrome-linux/chrome`) and the chrome‑for‑testing scheme Playwright ≥1.5x uses
(`chrome-linux64/chrome`, `chrome-mac-x64/…`, `chrome-win64/…`) — and picks the
newest build numerically. When the browsers dir has no bundled build, it falls
back to a **system Chrome channel install** at the known OS locations
(`/opt/google/chrome/chrome`, `/usr/bin/google-chrome-stable`, …) — the BOS
Docker image installs exactly that way (`npx playwright install chrome`), so
its `PLAYWRIGHT_BROWSERS_PATH` is empty on purpose. Preference order: bundled
Chromium (version‑matched) > system Chrome. No browser at all ⇒ the tools
answer with an install hint naming both options.

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

Resolved per call — policy changes apply to the **next session** with no restart.

---

## Security model (read carefully)

- **The sandbox is the real boundary.** The automation browser makes its **own**
  network requests and **bypasses** the proxy's `isBlockedHost` SSRF guard
  ([web proxy](../web-proxy/web-proxy.md)). Real containment = run BOS sandboxed
  (e.g. Docker with restricted egress).
- **Origin lists are advisory.** Per Playwright MCP docs they are **not** a security
  boundary; an empty allowlist inherits the upstream allow‑all default.
- **Isolated profile by default** — no access to real sessions.
- **Screenshot paths are contained**: user/model‑supplied filenames are validated
  (no absolute, no `..`) and pinned under `/Screenshots`.
- **Untrusted content = data, not instructions** — the agent is told not to obey
  instructions found in page content.

### Known gap

The `consent` setting (per‑use / per‑session elicitation) is **persisted but not
yet enforced** — the enforced controls today are the master switch, origin filters,
and the isolated profile. Tracked in `specs/discrepancies.md`.

---

## Tests

- `tests/assistant/browser-session.test.ts` — session statefulness, dedup, reap,
  crash‑drop, gating (fake MCP client via the hooks seam).
- `tests/assistant/browser-tools.test.ts` — registry exposure, snapshot
  composition, VFS path rewriting, filename containment, vision attachments.
- `tests/assistant/playwright-probe.test.ts` — both Chromium install layouts.
- `tests/agent/browser-tools-backfill.test.ts` — seed + one‑time allowlist
  backfill semantics.
