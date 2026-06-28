# Live version control (previewing BOS versions)

Because BOS can modify **its own code**, it needs a way to apply changes safely —
without the change breaking the very system that's running it. BOS solves this by
being able to run **multiple versions of itself at once**, behind a stable
**Supervisor**, so you can **preview** a candidate version, then **promote** or
**discard** it.

> This feature is active only when BOS is started through its **Supervisor**
> (`npm run supervisor`). Run normally, BOS just applies changes in place and the
> version controls are hidden.

---

## The idea

- A small, stable **Supervisor** owns the public address and routes your browser to
  a BOS version. It is never modified by the assistant.
- The running version is the **active** one. A code change becomes a **candidate**
  ("next") that is built separately — your active BOS keeps serving the whole time.
- You can **preview** the candidate in your own session, then **promote** it (make
  it the new active) or **discard** it.
- A previewed candidate uses an **isolated copy of your data** (see
  [Data isolation](../settings/data-isolation.md)), so trying it out never touches
  your real data. Promoting is **code‑only** — your data carries forward unchanged.

---

## The Top bar controls

When served through the Supervisor, the top bar shows:

- **Active: `<branch ▾>`** — a dropdown of branches. The current active version is
  marked `(active)`.
- Choosing a different branch **builds it as a candidate** and **pins your session**
  to it once it's ready (the page reloads into the candidate). While previewing a
  candidate you'll see:
  - **building…** while it builds, or **build failed** if the build broke,
  - **Promote** — make the candidate the new active version (when it's ready), and
  - **Discard** — drop the candidate and return to active.
- Choosing the base branch again takes you **back to the active version**.

If the assistant just built or changed an **app**, you'll also see an **app
preview** with **Promote app** / **Discard app** (apps are previewed via a branch
in the apps content repo).

---

## The Supervisor control page (always reachable)

The Supervisor also serves a minimal, version‑independent control page at
**`/__supervisor`**. Because it's rendered by the Supervisor itself (not by any BOS
version), it stays reachable **even if a BOS version's UI is broken** — your
guaranteed escape hatch. From it you can preview next/previous, go back to active,
**promote**, **rollback**, **discard**, and **push** the canonical history to your
git remote.

---

## Promote, rollback, discard

- **Promote** — integrates the candidate (fast‑forwards it into the base branch),
  tags it, and flips the active version to it. In‑flight requests on the old
  version finish before it's retired (so a streaming chat isn't cut off).
- **Rollback** — return to the previously‑good version.
- **Discard** — drop the candidate and its isolated data clone.

---

## Good to know

- **Promote is code‑only.** Your chats, memory, and skills are shared canonical
  data and carry across a promote; the preview's data clone is thrown away.
- **Schema compatibility.** Because a rollback returns to older code against the
  same data, changes to how data is stored must stay backward‑compatible — the
  assistant's Developer is expected to honor this.
- **Background work stays on active.** Automated jobs run against the active
  version, never a preview. Preview is for interactive testing.
