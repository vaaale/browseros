# Live version control (previewing BOS versions)

Because BOS can modify **its own code**, it needs a way to apply changes safely —
without the change breaking the very system that's running it. BOS solves this by
running a stable **base** version plus, on demand, **one preview** of a feature
branch behind a stable **Supervisor**, so you can **preview** a change, then
**promote** or **stop** it.

> This feature is active only when BOS is started through its **Supervisor**
> (`npm run supervisor`). Run normally, BOS just applies changes in place and the
> version controls are hidden.

---

## The idea

- A small, stable **Supervisor** owns the public address and routes your browser to
  a BOS version. It is never modified by the assistant.
- The running version is the **base**, always on the base port. A code change is
  built as a **preview** on its own port — your base BOS keeps serving the whole
  time.
- You can **preview** a feature branch in your own session, then **promote** it (make
  it the new base) or **stop** it.
- A preview uses an **isolated copy of your data** (see
  [Data isolation](../settings/data-isolation.md)), so trying it out never touches
  your real data. Promoting is **code‑only** — your data carries forward unchanged.

---

## The Top bar controls

When served through the Supervisor, the top bar shows:

- **Base: `<branch ▾>`** — a dropdown of **all** branches. The current base version
  is marked `(base)`.
- Choosing a different branch **builds it as a preview** and **pins your session** to
  it once it's ready (the page reloads into the preview). While a preview exists
  you'll see:
  - **building…** while it builds, or **build failed** if the build broke,
  - **Preview** — point your session at the preview (and a **previewing** marker once
    you're on it),
  - **Promote** — make the preview the new base version (when it's ready), and
  - **Stop** — kill and discard the preview (its **branch is kept**) and return to
    base.
- Choosing the base branch again takes you **back to the base version**.
- Switching to another branch while previewing **stops the current preview first**
  (only one preview runs at a time).

> When you ask the assistant to fix BOS itself, its Developer builds the fix as a
> preview — it is **not** the base version yet. If you test before previewing, you're
> still on the old version and "nothing changed": click **Preview** to see the fix,
> then **Promote** to keep it. (Don't ask it to "apply the fix again" — that edits the
> live checkout and blocks Promote.) If you **Stop** to refine it, just ask the
> assistant to improve it again — it continues on the **same** feature branch.

If a control can't proceed, the reason is shown **inline next to the buttons** (e.g.
a Promote refused because the live checkout has uncommitted changes) rather than the
button appearing to do nothing.

If the assistant just built or changed an **app**, you'll also see an **app preview**
with **Promote app** / **Discard app** (apps are previewed via a branch in the apps
content repo).

---

## The Supervisor control page (always reachable)

The Supervisor also serves a minimal, version‑independent control page at
**`/__supervisor`**. Because it's rendered by the Supervisor itself (not by any BOS
version), it stays reachable **even if a BOS version's UI is broken** — your
guaranteed escape hatch. From it you can Preview, go back to base, **Promote**,
**Stop/discard**, and **push** the canonical history to your git remote.

---

## Promote & stop

- **Promote** — integrates the preview (fast‑forwards it into the base branch), tags
  it, and makes it the new base. The new base is built and health‑checked **before**
  the old base is replaced, so the base branch is only advanced once the new version
  is proven healthy; if the new version fails to come up, the previous base is
  restored automatically and the base branch is left untouched.
  - If the **base moved on** since the preview was built (so it's no longer a straight
    fast‑forward), Promote **automatically rebases** the preview onto the latest and
    **rebuilds** it.
  - If the changes can't be combined automatically (a true conflict), Promote tells
    you which files need a manual merge. (A built‑in conflict editor is planned.)
  - Promote also refuses (reason shown inline) if the live checkout has uncommitted
    changes — commit, stash, or discard them, then retry.
  - A short interruption on the base port during the swap is expected (the build is
    done beforehand, so it's just a quick restart).
- **Stop** — kill and discard the preview and its isolated data clone. The feature
  **branch is kept**, so you can preview or continue working on it again later.

---

## Good to know

- **Promote is code‑only.** Your chats, memory, and skills are shared canonical data
  and carry across a promote; the preview's data clone is thrown away.
- **One feature per conversation.** A delegated dev task is tied to its chat: ask the
  assistant to improve "the thing we worked on" and it continues on the same feature
  branch — even after you Stopped the preview. If you preview a different branch from
  the dropdown, the assistant works on **that** one.
- **Every promote is tagged** (`bos/v<timestamp>`) so the history of promoted versions
  is recoverable from git.
- **Background work stays on base.** Automated jobs run against the base version,
  never a preview. Preview is for interactive testing.
