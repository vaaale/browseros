# BrowserOS DataFS — Data-Isolation Layer — Specification

DataFS is the single layer through which **all** BOS runtime state is read and written. It exists to serve the live-version-control feature in `spec/self-modification/self-modification.md`: it lets multiple BOS versions **share one canonical data store** while giving a **previewed candidate an isolated, throwaway copy** so that manual testing never pollutes production state. It is the data-plane counterpart to that document's control plane.

DataFS MUST work on **any filesystem BOS can run on** — local disks, unprivileged Docker volumes, and network/removable mounts (SMB/CIFS, FAT/exFAT, object-storage FUSE) — by **probing filesystem capability at startup and degrading gracefully**. It MUST NOT hard-depend on any one filesystem feature.

### Motivation / current state
Today data access is scattered raw `fs` calls rooted at `process.cwd()/data` across many stores (the VFS, settings, memory, skills, agents, docs, config, the provider config, the installed-apps registry, the MCP-servers registry). Write discipline is inconsistent: some stores write atomically (temp file + rename), most write in place. Network and removable filesystems lack hardlinks and weaken atomic-rename. DataFS therefore MUST (a) **centralize** access behind one module, (b) **standardize atomic writes**, and (c) **never assume** a specific filesystem capability.

---

## 1. Principles

- **Single funnel.** All runtime-state access MUST go through one DataFS module rooted at a configurable data directory. No store may join `process.cwd()/data` directly any more.
- **Configurable root.** The data root MUST be resolvable from an environment variable (`BOS_DATA_DIR`), defaulting to `<cwd>/data`. The Supervisor launches each version with the appropriate root: the canonical **base** for `active`, an isolated **clone** for a previewed candidate.
- **Base read-only during preview (the core invariant).** While a candidate is previewed, the canonical base data is only ever **read**; the preview's writes go to a separate target. This invariant requires nothing of the filesystem beyond read+write, so it holds even on SMB/FAT/FUSE.
- **No hard filesystem dependency.** The core path MUST require only read+write. Copy-on-write / snapshot features are **optimizations**, never the contract.
- **Atomic writes where supported.** Writes SHOULD be atomic (temp-in-same-dir → flush → `rename` over target); where the filesystem does not guarantee atomic rename, the write still functionally replaces the file and crash-atomicity degrades to best-effort (a pre-existing, tolerable risk).
- **Code-only promote.** DataFS supports **discarding** a clone, not merging it back into base. Promote (per `spec/self-modification/self-modification.md` §6) discards the preview clone; base carries forward. Promote-and-merge is **explicitly out of scope**.
- **Out of scope.** Running BOS live directly against a network mount via a sync/replication layer is **explicitly skipped**. The recommendation for network-mounted data is to keep the live data root on local storage; DataFS does not implement a sync engine.

---

## 2. The DataFS module (interface)

- A single **server-only** module exposing path-relative operations against the resolved root, e.g.: `root()`, `readText` / `readBuffer`, `writeAtomic(text|buffer)`, `list`, `stat`, `exists`, `mkdir`, `remove`, `rename`.
- **All existing stores MUST be migrated to it.** Migration scope (every site that currently joins `process.cwd()/data`): the VFS (`os/vfs.ts`), OS settings (`os/settings.ts`), installed-apps registry (`lib/apps/store.ts`), generic config (`lib/config/store.ts`), provider config (`lib/agent/provider.ts`), docs hub (`lib/docs/store.ts`), agents store (`lib/agent/subagents/store.ts`), MCP servers (`lib/mcp/store.ts`), memory (`lib/agent/memory/*`), and skills (`lib/agent/skills/*`). The VFS retains its path-escape jail; DataFS supplies the root resolution, atomic writes, and clone/overlay behavior.
- **One write path.** Writes MUST funnel through `writeAtomic()`. This gives crash-safety to every store and is the prerequisite that makes the hardlink-farm backend (§3) correct.

---

## 3. Isolation methods (clone backends)

A previewed candidate's writable data root is produced from base by a **clone backend**. Every backend MUST preserve the base-read-only invariant (§1). BOS MUST implement all of the following, ordered best fast-path → universal floor:

1. **ZFS / btrfs snapshot** — native copy-on-write snapshot of a dedicated dataset/subvolume (`zfs snapshot` + clone, or `btrfs subvolume snapshot`). Instant, space-free, point-in-time consistent (no quiescing needed). **Requires** the data on a CoW dataset/subvolume, the tools, and privileges.
2. **Reflink copy** — `cp --reflink=auto` / `FICLONE`. Instant block clone on btrfs / XFS-reflink / ZFS; **silently falls back to a full copy** where reflinks are unsupported. Requires a reflink-capable filesystem for the fast path.
3. **Hardlink farm** — `cp -al` (a full directory mirror whose files are hardlinks to base's inodes). Cheap and space-efficient; correct **only because every write is atomic temp+rename** (a modify forks a new inode, leaving base's inode untouched). **Requires POSIX hardlink support** (ext4, xfs, zfs, btrfs); unavailable on SMB/CIFS, FAT/exFAT, and many FUSE mounts.
4. **Plain deep copy** — recursive copy (`fs.cp`) of base → clone. **Requires only read+write → the universal floor**; works on any filesystem including SMB/FAT/FUSE. Cost: O(size) and full duplication.
5. **Sparse overlay (application-level CoW)** — DataFS resolves reads overlay→base, writes only to the overlay, records deletes as **whiteout markers**, and merges directory listings. No hardlinks and no bulk copy; lazy per-file copy-up; base is only ever read. **Requires only read+write** (as FS-agnostic as the floor) but is cheap like CoW. Cost: implementation complexity (whiteouts, read-through resolution, and the VFS's arbitrary nested user trees).

**Discarding a clone:** for backends 1–4, delete the clone directory or destroy the snapshot/clone; for backend 5, delete the overlay directory. Because base was read-only throughout, **switch-back/discard never touches base** — it is simply "drop the clone."

---

## 4. Capability probe & degradation

- At startup (and on demand from Settings) DataFS MUST **probe the data filesystem's capabilities**: reflink support, hardlink support, atomic-rename reliability, and CoW dataset/subvolume + privilege availability (ZFS/btrfs).
- The probe yields the set of **compatible** isolation methods. The **plain deep copy (#4) and the sparse overlay (#5) are ALWAYS compatible** (they need only read+write); the others are gated on the probe.
- The active method is chosen from the compatible set. The default SHOULD be the best available (snapshot > reflink > hardlink > overlay/copy), but the user's setting (§5) overrides it within the compatible set.

---

## 5. The isolation-method setting (BOS-level)

The isolation method MUST be a **BOS-level configuration value** with its own configuration namespace (e.g. `datafs`). Per the BOS configuration system this automatically yields a Settings tab **and** exposes the setting to the assistant as a tool.

- **First-run wizard.** On first startup — alongside the AI-provider and Dev-Harness steps (`spec/bos.md`) — the wizard MUST let the user choose the isolation method. It MUST default to the best **probe-compatible** option and give a one-line explanation of each choice.
- **Settings.** The method MUST be editable in Settings. **Only probe-compatible methods are selectable**; incompatible methods MUST be shown disabled with the reason (e.g. "hardlinks unsupported on this filesystem", "no CoW dataset detected"). Changing the setting consults/re-runs the probe.
- **Transparency.** Settings SHOULD surface the probe result (detected filesystem and which capabilities were found) and provide a manual **re-probe** action, so the user's choice is informed.

---

## 6. Atomic-write standardization

- Every data write MUST go through DataFS `writeAtomic()`: write a temp file in the **same directory** as the target → flush → `rename` over the target.
- This is **required** for the hardlink-farm backend (#3) to be safe (an in-place truncate of a hardlinked file would corrupt base's shared inode) and is good crash-safety hygiene for every backend. The memory store already follows this pattern; the others MUST be migrated to it (§2).
- Where the filesystem does not guarantee atomic rename-over-existing (e.g. some SMB servers), the write still functionally replaces the file; only crash-atomicity degrades to best-effort.

---

## 7. Lifecycle integration (with self-modification)

Driven by the Supervisor (`spec/self-modification/self-modification.md`):
- **Provision** (begin a candidate/preview): DataFS produces an isolated clone of base using the active method; the candidate process is launched with `BOS_DATA_DIR=<clone>`.
- **Preview**: the candidate reads/writes its clone; base and `active` are unaffected.
- **Switch-back / discard**: DataFS drops the clone (base never changed).
- **Promote (code-only)**: the clone is discarded; base remains canonical and carries to the new `active`. No merge.
- **Active with no preview in progress**: uses base directly, with **zero** clone/overlay overhead.

---

## 8. Safety & constraints

- **Base read-only invariant is the linchpin** — any backend that would mutate base during a preview is non-conformant.
- **Secrets.** The provider API key (`provider.json`) lives in base; a clone contains a copy only if the candidate modifies it. Clones/overlays are local artifacts and MUST NOT be shipped anywhere.
- **Schema compatibility.** (See `spec/self-modification/self-modification.md` §9.) Because base is shared and promote is code-only, on-disk `data/` schema changes MUST be backward-compatible so a rollback to prior code still reads the store.
- **Cleanup / GC.** Orphaned clones (left by a crash) MUST be reclaimable; the Supervisor SHOULD garbage-collect clones/overlays that have no live owning process.

---

## 9. UI & configuration

- **Settings (`datafs` namespace):** the isolation method (only probe-compatible options selectable, incompatible ones shown disabled with a reason), a read-out of detected filesystem capabilities, and a manual re-probe action. Auto-exposed to the assistant per the configuration system.
- **First-run wizard step** (§5).

---

## 10. Relationship to other specs

- **`spec/self-modification/self-modification.md`** — the control plane that drives clone provisioning, preview, and code-only promote/discard; this document is authoritative for the data plane.
- **`spec/memory/memory.md`** — the memory store is one of the stores routed through DataFS; its durability/crash-safety requirements align with the atomic-write standard in §6.
- **`spec/bos.md`** — the configuration system (a namespace yields a Settings tab + an assistant tool) and the first-startup wizard.
