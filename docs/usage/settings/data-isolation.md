# Settings → Data Isolation

This tab controls how a **previewed BOS version's data** is kept separate from your
**live data** during [live version control](../versions/live-version-control.md).

When you preview a candidate version of BOS, it runs against an **isolated
copy‑on‑write clone** of your data, so testing the candidate (sending chats,
changing settings, creating files) can never pollute your real data. Your live
data is only ever **read** during a preview. When you promote a candidate, the
clone is discarded and your canonical data carries forward unchanged (promote is
**code‑only**).

---

## Choosing a method

- **Auto (recommended)** — BOS picks the best method your filesystem supports.
- **Reflink (copy‑on‑write)** — instant block‑level clone on filesystems that
  support it (falls back to a copy otherwise).
- **Hardlink farm** — a cheap directory mirror sharing file data, safe because all
  BOS writes are atomic.
- **Full copy** — a plain recursive copy. Works on **any** filesystem; the
  universal fallback.

Only methods compatible with your filesystem are offered. The first‑run wizard sets
this initially and defaults to the best available; you can change it here later.

---

## When does this matter?

Only when BOS runs under its **Supervisor** (live version control) and you actually
**preview** a candidate version. When nothing is being previewed, the active BOS
uses your real data directly with **zero** overhead.

> **Tip:** for data on a network/removable mount, prefer keeping your live data on
> local storage. **Full copy** is the safe universal choice when in doubt.
