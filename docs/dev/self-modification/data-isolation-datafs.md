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

### The probe tests the PAIR, not the data dir

Every capability is measured **from a file in `dataDir()` to a path under
`dataClonesDir()`** (`src/os/data-dir.ts`, mirroring the Supervisor's `CLONES`),
and the clone root that was measured is reported back as `caps.cloneRoot`.

This is not a detail. `link(2)` refuses to cross a **mount**, even when both
paths are on the same filesystem, and the bastion gives each container the two
directories as two separate bind mounts:

```
bind …/<user>/data        -> /app/data
bind …/<user>/data-clones -> /data-clones
```

The probe used to create both its scratch file and its link inside `dataDir()`,
which always succeeds, so it reported `hardlink: true` on a deployment where
`cp -al` failed with `Invalid cross-device link` on every single file. The clone
layer then fell back to `cp -a` and each "free" clone silently became a full
copy of the data dir. See `tests/datafs/probe-clone-root.test.ts`.

**A capability probe has to perform the capability**, against the exact pair of
paths the operation will use.

---

## Clone (`src/lib/datafs/clone.ts` + the Supervisor)

The actual preview clone is provisioned by the Supervisor's `provisionClone(target)`
(`tools/supervisor/supervisor.mjs`), which reads the `datafs` method and runs `cp`:

| method | command | notes |
|---|---|---|
| `reflink` | `cp -a --reflink=auto` | block‑level CoW; falls back to copy |
| `copy` | `cp -a` | plain recursive copy (universal) |
| `auto` / `hardlink` | `cp -al` | hardlink farm (shared inodes) |

**Hardlink isolation is safe because all BOS writes are atomic**
(`writeFileAtomic` = temp + rename → a new inode, so the canonical file is never
mutated in place).

### The method is verified before it is used, and reported after

`provisionClone(target)` returns **`{ method, target, degradedFrom?, reason? }`**
— the method *actually used*, which is not always the one configured:

1. `auto` resolves by **performing one link (or one block clone) into the clone
   target's own parent directory**, cached per directory. A method that cannot
   work there is never chosen.
2. An **explicitly configured** method that the same probe rejects is logged at
   **error** level and returned as `degradedFrom`, because the substitute costs a
   full copy of the data dir *per branch*.
3. A failure *after* a successful probe still falls back to `cp -a`, but loudly,
   and the caller is told.

`_provisionPreview` carries any degradation onto the preview as `cloneWarning`,
which `/__supervisor/begin` returns alongside `baseWarning`.

`cp` is run through `runCp()`, which keeps only the head of stderr and drains the
rest. `execFile`'s 8 MB `maxBuffer` used to overflow on the one-error-per-file
flood that a cross-mount `cp -al` produces, so the rejection read
`stderr maxBuffer length exceeded` and destroyed the line that said
`Invalid cross-device link` — a diagnostic that failed under exactly the
conditions it existed to diagnose.

### The clone source: making the hardlink farm possible at all

`link(2)` refuses to cross a **mount**, even when both paths are on one
filesystem. Two directories therefore share "link-ability" only if one mount
covers both — and in the bastion the data dir and the clone root were two
separate binds of two sibling host directories, so `cp -al` failed with EXDEV
on every file and every clone was a full copy.

`BOS_CLONE_SOURCE` names the **single-mount view of the canonical data dir**:
the same directory `BOS_DATA_DIR` names, reached through a path that shares a
mount with the clone root. The bastion binds the user's own directory once at
`/bos` and sets:

```
BOS_CLONE_SOURCE=/bos/data          # same dir as /app/data, one mount with ↓
BOS_DATA_CLONES=/bos/data-clones
BOS_DATA_DIR=/app/data              # unchanged
```

`BOS_DATA_DIR` deliberately does **not** move: `installItemLink` writes
`data/system/<id>` as an ABSOLUTE symlink, so re-addressing the data dir would
break every installed item in every existing container.

Unset — the standalone layout — it is exactly `CANONICAL_DATA` and nothing
changes. It is read only by the Supervisor's clone layer
(`cloneSource()` in `tools/supervisor/lib/worktree.mjs`); it is **not** a second
data dir, and anything it points at must be the very same directory.
See `tests/supervisor/clone-source-view.test.mjs` and
`tests/bastion/clone-single-mount.test.ts`.

### A directory at the clone path is not a clone

`provisionClone` returns `{ method: "existing" }` only for a clone carrying
**`.bos-clone-complete`**, written inside the staging dir as the last step
before the atomic rename.

The staging dance keeps a half-finished *copy* from ever appearing at the
target; it cannot stop something else creating that path. Production had
`/data-clones/bos/<branch>` holding just `events/`, `user-apps/` and `vfs/` —
what `mountCoupled` and a running preview write — after the real clone was
deleted from under the in-memory preview record. The old existence check called
that "already provisioned", so the preview ran against a data dir with no
config, no agents and no installed items, permanently and silently.

A marker-less directory is **not** simply rebuilt — every clone predating the
marker is in that state, and rebuilding would discard a live preview's data.
It is compared against the clone source's top-level entries: carrying all of
them means complete, so it is **adopted** (marker written, content untouched);
missing entries means stub, and it is rebuilt. See
`tests/supervisor/clone-completeness.test.mjs`.

### Clones are reclaimed when their branch goes away

`reconcileDataClones()` (`tools/supervisor/lib/worktree.mjs`, run at boot right
after `reconcileWorktrees()`) removes:

- `<CLONES>/bos/<name>` when no `bos/<name>` branch (nor any `bos/<name>/…`) exists
- `*.provisioning` staging dirs, which are only ever debris from an interrupted copy

A clone can hold data the preview itself wrote, so a clone whose branch still
exists is never touched, and anything outside the `bos/<branch>` layout is left
alone. Before this existed, `discardPreview` was the *only* thing that removed a
clone — deleting an abandoned branch by hand left its clone on disk forever.

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
