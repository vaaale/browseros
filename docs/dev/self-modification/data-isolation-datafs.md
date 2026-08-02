# Self-modification: data isolation (DataFS)

Spec: `specs/006-data-isolation/spec.md`. User‑facing:
`docs/usage/settings/data-isolation.md`.

When a candidate BOS version is previewed, it must run against an **isolated copy**
of `data/` so testing it can't corrupt live data. Modules: `src/lib/datafs/`.

---

## Capability probe (`src/lib/datafs/probe.ts`)

Detects what the host filesystem supports and which isolation methods are viable:

- `IsolationMethod = "reflink" | "hardlink" | "copy"` plus `"auto"`.
- Reports flags like reflink (CoW) support and whether the data dir sits on
  ZFS/btrfs, used to rank methods. Exposed via **`/api/datafs`** (GET) → the
  compatible methods. The First‑Run wizard and the **Data Isolation** tab
  (`DataFsTab`, `datafs` namespace) read it and default to the best available.

The chosen method is persisted to `data/config/datafs.json` (`{ method }`).

---

## Clone (`src/lib/datafs/clone.ts` + the Supervisor)

The actual preview clone is provisioned by the Supervisor's `provisionClone(target)`
(`tools/supervisor/supervisor.mjs`), which reads the `datafs` method and runs `cp`:

| method | command | notes |
|---|---|---|
| `reflink` | `cp -a --reflink=auto` | block‑level CoW; falls back to copy |
| `copy` | `cp -a` | plain recursive copy (universal) |
| `auto` / `hardlink` | `cp -al` | hardlink farm (shared inodes) |

Any failure falls back to a full `cp -a`. **Hardlink isolation is safe because all
BOS writes are atomic** (`writeFileAtomic` = temp + rename → a new inode, so the
canonical file is never mutated in place).

---

## How it's wired

- The Supervisor gives each version its own `BOS_DATA_DIR` (`dataDir()` reads it).
  Active = canonical `data/`; a candidate = a clone under `BOS_DATA_CLONES`.
- **Promote is code‑only:** the new active restarts on **canonical** data and the
  clone is discarded — so anything written under `data/` during a preview
  (config, memory, logs, …) does not survive promote/discard, by design,
  **except one directory** (below).

### Exception: `user-apps/` is branch-coupled, not cloned

`dataDir()/user-apps` (the user's local marketplace — a real git repo,
`src/lib/gitfs/store.ts`) used to be just part of the blanket clone like
everything else here — a disconnected, un-branched snapshot. That silently
destroyed marketplace apps installed during a preview: they lived only in the
clone, which is discarded on promote regardless of whether the code merge
itself succeeded. It's now mounted the same way a spec store is
(020-branch-coupled-specs): a git worktree of the canonical `user-apps` repo,
checked out on the *same* `bos/<feature>` branch as the code, placed at
`<dataDir>/user-apps` inside the clone (not inside the code worktree — unlike
specs there's no root override to redirect it, so mounting it exactly where
`dataDir()/user-apps` already resolves needs no changes anywhere in `src/`).
Promote merges it right after the spec stores and before the clone is
discarded; discard drops the worktree + branch. See "user-apps/ is
branch-coupled too" in `docs/dev/self-modification/live-version-control.md`
for the full mechanics, including the one wrinkle unique to it (its primary
checkout isn't always on its default branch, unlike a spec store).

---

## Atomic writes are the contract

`src/os/atomic-write.ts` `writeFileAtomic()` (temp + rename) is what makes the
hardlink farm safe and keeps stores crash‑consistent. **Every store that persists
under `data/` must write atomically.** (Memory uses its own temp+rename; skills,
agents, config, settings use `writeFileAtomic`.)

> **Spec gap:** `datafs.md` envisions a *single* DataFS funnel (`root()`,
> `writeAtomic`, …) and **five** backends (incl. ZFS/btrfs snapshots and a sparse
> overlay). Today there is **no unified funnel** (stores use `dataDir()` + atomic
> write directly) and only **reflink/hardlink/copy** are implemented (snapshot/
> overlay are not). See `specs/discrepancies.md`.
