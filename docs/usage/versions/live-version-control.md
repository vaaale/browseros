# Live version control (previewing BOS versions)

Because BOS can modify **its own code**, it needs a way to apply changes safely —
without the change breaking the very system that's running it. BOS solves this by
running a stable **base** version plus, on demand, **feature-branch previews**
behind a stable **Supervisor**, so you can **preview** a change, then **promote**,
**stop**, or **discard** it.

> This feature is active only when BOS is started through its **Supervisor**
> (`npm run supervisor`). Run normally, the version controls are hidden and the
> Developer refuses BOS source edits because it cannot provision an isolated
> feature-branch worktree.

---

## The idea

- A small, stable **Supervisor** owns the public address and routes your browser to
  a BOS version. It is never modified by the assistant.
- The running version is the **base**, always on the base port. A code change is
  built as a **preview** on its own port — your base BOS keeps serving the whole
  time.
- You can build several feature branches at the same time, preview one in your own
  session, then **promote** it (make it the new base), **stop** it, or **discard**
  it.
- A preview uses an **isolated copy of your data** (see
  [Data isolation](../settings/data-isolation.md)), so trying it out never touches
  your real data. Promoting is **code‑only** — your data carries forward unchanged.

---

## The Top bar controls

When served through the Supervisor, the top bar shows:

- A large **BASE** or **PREVIEW** marker so you always know which version you are
  using.
- A branch dropdown containing **all** branches. The current base branch is marked
  `(base)`.
- Choosing a non-running branch **builds and starts it as a preview** while you stay
  on base. While that preview exists you'll see:
  - **building `<branch>`...** while it builds, or **failed** plus **Retry** if the
    build broke,
  - **Preview** — point your session at the preview (and a **previewing** marker once
    you're on it),
  - **Promote** — make the preview the new base version,
  - **Stop** — stop the preview server but keep its worktree/branch, and
  - **Discard** — delete the preview worktree and branch.
- Selecting an already-running preview switches to it immediately.
- Choosing the base branch again takes you **back to the base version**.
- **Log** opens recent Supervisor activity (builds, switches, failures).

> When you ask the assistant to fix BOS itself, its Developer builds the fix as a
> preview — it is **not** the base version yet. If you test before previewing, you're
> still on the old version and "nothing changed": click **Preview** to see the fix,
> then **Promote** to keep it. If you **Stop** to refine it, choose that branch as the
> conversation's **Active feature branch** in the Assistant header before delegating
> more work.

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
**Stop**, **Discard**, and **push** the canonical history to your git remote.

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
- **Stop** — stop the preview server and return to base, but keep the worktree,
  isolated data clone, and feature branch so you can resume it later.
- **Discard** — stop the preview, delete its worktree/data clone, and delete the
  feature branch.

---

## Good to know

- **Promote is code‑only.** Your chats, memory, and skills are shared canonical data
  and carry across a promote; the preview's data clone is thrown away.
- **Active feature branch per conversation.** The Assistant header has an **Active
  feature branch** dropdown. Developer harness work for that conversation requires a
  selected `bos/...` branch; previewing a branch in the toolbar does not by itself
  change which branch the assistant will modify.
- **Every promote is tagged** (`bos/v<timestamp>`) so the history of promoted versions
  is recoverable from git.
- **Background work stays on base.** Automated jobs run against the base version,
  never a preview. Preview is for interactive testing.
