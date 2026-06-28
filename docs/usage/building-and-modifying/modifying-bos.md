# Modifying BOS itself

Beyond building standalone apps, the assistant can **change BOS itself** — its
built‑in apps, Settings pages, the desktop, and its server logic. This edits the
OS's own source code.

> Like building apps, this is done by the **Claude Developer** sub‑agent, never the
> local model, and needs a working [Dev Harness](../settings/dev-harness.md).

---

## Just ask

> "Add a dark/light theme toggle to Settings → Appearance."

> "Change how the Skills page lists skills — show the score."

> "Add a 'Calendar' built‑in app."

The assistant delegates the whole request to the Developer, which has access to
BOS's own source. It works on a **feature branch**, finds and edits the right
files, type‑checks, and stages the changes — so a change is focused and reversible.

---

## How changes appear

- Most edits **hot‑reload** in development — you'll see the change without
  restarting.
- Some changes (new dependencies, server/configuration changes) need a **restart**;
  the assistant will say so.

---

## Building vs. modifying — which is it?

- **Build an app** → a self‑contained app in a window, not part of BOS's code.
  See [Building apps](building-apps.md).
- **Modify BOS** → change BOS's own behavior/appearance/features (its source).

If you're not sure, just describe what you want; the assistant picks the right path
(it follows its built‑in "Develop in BrowserOS" skill to decide).

---

## Safety: previews, branches, and tests

- The Developer always works on a **feature branch** to minimize blast radius.
- It's expected to **write tests** for its change.
- When BOS runs under the **Supervisor**, a code change becomes a **candidate
  version** you can **preview**, then **promote** or **discard** — without taking
  down the running OS. See [Live version control](../versions/live-version-control.md).

---

## Important: the assistant won't hunt for code in your files

BOS's own source is **not** in your virtual file system — the VFS is *your*
sandboxed data. The assistant will never try to read or edit BOS code through the
file tools; it always delegates source changes to the Developer. If the Developer
or Claude harness isn't available, it tells you instead of improvising.

---

## Costs

Modifying BOS runs a real Claude Code session and consumes Claude usage/credits.
Larger changes cost more.
