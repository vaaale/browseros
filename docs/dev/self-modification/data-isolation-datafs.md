# Self-modification: data isolation (DataFS)

Spec: `spec/self-modification/datafs.md`. User‑facing:
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
  clone is discarded.

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
> overlay are not). See `spec/discrepancies.md`.
