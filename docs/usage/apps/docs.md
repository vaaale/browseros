# Docs

The **Docs** app is BrowserOS's built‑in **documentation reader**. It renders the
project documentation — the same pages you're reading now — with full Markdown,
right inside the OS.

---

## Using it

- Use the **Usage / Developer** switch at the top of the sidebar to choose which
  documentation tree to read:
  - **Usage** — end‑user help (the desktop, the apps, the assistant, settings…).
  - **Developer** — technical docs for people (and the developer agent) extending
    or modifying BOS.
- Browse the **collapsible tree**: click a folder to expand or collapse it, click
  a page to read it in the main area.

It's a **read‑only reader** — there's no editing inside the app.

---

## Where the content comes from

The Docs app renders the repository's documentation trees:

- `docs/usage/**` — this user guide.
- `docs/dev/**` — the developer documentation.

These are **source files** that ship with BOS, so the docs always match the
version of BOS you're running. When the assistant adds, changes, or removes an app
or feature, it updates these pages as part of the change (by editing the source via
the developer sub‑agent) — so the in‑OS docs stay current as your BOS evolves,
including pages describing apps you asked it to build.

> **Tip.** While previewing a candidate version of BOS (see *Live version
> control*), the Docs app shows *that* version's documentation, so you can read
> exactly what changed before you promote it.
