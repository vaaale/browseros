# Browser

The **Browser** app lets you view external web pages **inside** BOS. Pages are
loaded through a built‑in **proxy** so they render in a window without the usual
cross‑origin errors.

---

## Using it

- **Address bar** — type a URL or a search term and press Enter:
  - A full URL (`https://…`) loads directly.
  - A bare domain (e.g. `example.com`) is treated as a host.
  - Anything else becomes a **web search** (via DuckDuckGo).
- **Back / Forward** — navigate your history within the window.
- **Reload** — refresh the current page.
- **Home** — return to the start page.
- **Open original in a new tab** — the ↗ button opens the real page in your actual
  browser tab (outside the proxy).

The window title updates to show the current site's hostname.

---

## How the proxy works (and why)

External pages are fetched and rewritten by BOS so they stay "same‑origin" inside
the OS. The proxy rewrites links, styles, and scripts to keep loading through BOS,
and renders the page inside a sandboxed frame. This is what lets normal websites
display inside a BOS window.

You can also ask the **assistant** to "open `<url>` in the browser" and it will
launch this app pointed at that page.

---

## Limits & things to know

The proxy is built for **normal web pages**. Out of scope:

- **DRM / streaming video** sites (e.g. video platforms) won't play.
- **WebSockets** are not proxied, so apps that rely on live socket connections
  won't fully work.

If a page misbehaves inside the proxy, use **Open original in a new tab** to view
it directly.

---

## Browser app vs. browser *automation*

This app is for **you** to *view* pages. There is a separate, more powerful
capability — **browser automation** — that lets the **assistant** drive a real
browser to *act* on pages (fill forms, click, extract data). That is off by
default and configured under **Settings → Browser Automation**; see
[Browser automation](../settings/browser-automation.md).
