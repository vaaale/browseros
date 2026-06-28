# Web proxy (the Browser app's engine)

The Browser app renders external pages **same‑origin** through a path‑based proxy so
they display inside an iframe without cross‑origin breakage.

---

## Path-based scheme (`src/lib/proxy-path.ts`)

`https://host/a/b.js` → `/api/proxy/https/host/a/b.js` (`PROXY_PREFIX =
"/api/proxy/"`; the scheme is its own path segment, **no `//`**). Path‑based (not
`?url=`) so the browser's own **relative** resolution — including ES‑module imports
— maps back through the proxy. `toProxyPath()` builds it; `fromProxySegments()`
reconstructs the target.

---

## The route (`src/app/api/proxy/[[...path]]/route.ts`)

`GET` only, `force-dynamic`, `maxDuration = 60`, `MAX_BYTES = 6 MiB`:

1. `resolveTarget` reconstructs the URL from the path (preserving trailing slash) or
   the legacy `?url=`.
2. Reject non‑http(s); **`isBlockedHost`** SSRF guard (403).
3. Fetch upstream (browser‑like UA, follow redirects).
4. **text/html** → `rewriteHtml`; **text/css** → `rewriteCss`; otherwise stream bytes
   through unchanged. All responses `Cache-Control: no-store`.

---

## Rewriting (`src/lib/proxy-rewrite.ts`, server‑only)

- `proxify(value, base)` — resolves a URL against `base` and routes it back through
  the proxy (skips `data:`/`blob:`/`javascript:`/`mailto:`/`tel:`/`#`/already‑proxied).
- `rewriteHtml` — strips CSP `<meta>` and `<base>`, rewrites `src/href/action/poster`,
  and injects a **runtime shim** that monkey‑patches `fetch`/`XHR.open` so the page's
  **dynamic** requests are proxied too.
- `rewriteCss` — rewrites `url(...)` and `@import`.

---

## SSRF guard (`src/lib/net.ts`)

`isBlockedHost(hostname)` blocks `localhost`, `*.local/.home/.internal`, loopback,
RFC‑1918 / link‑local / CGNAT ranges, `0.0.0.0`, `::1`. Shared by the proxy **and**
the agent's `web_fetch` tool (`fetchText`, which also strips HTML to text and caps
size).

---

## In the browser app

`src/apps/browser/index.tsx` normalizes the address bar (URL vs. bare host vs.
DuckDuckGo search), renders `toProxyPath(current)` in a **sandboxed** iframe
(`allow-scripts allow-forms allow-popups allow-same-origin`), and offers
back/forward/reload/home + "open original in a new tab".

---

## Scope & boundaries

- **In scope:** ordinary HTML/CSS/JS pages.
- **Out of scope:** DRM/streaming video; **WebSockets are not proxied**.
- **Different trust tier from automation.** This proxy is guarded by
  `isBlockedHost`. **Browser automation** ([here](../automation/browser-automation.md))
  drives a real browser that makes its **own** requests and **bypasses** this guard —
  containment there relies on the sandbox.
