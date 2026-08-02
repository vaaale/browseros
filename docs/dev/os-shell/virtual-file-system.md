# OS shell: the Virtual File System (VFS)

`src/os/vfs.ts` is the user's sandboxed storage, rooted at `data/vfs`. **It is not
BOS source** — it can never see or edit the repo.

---

## Module (`src/os/vfs.ts`, server‑only)

Rooted at `dataDir()/vfs` with `resolveSafe()` refusing path escapes. Exposes:

`list` · `stat` · `readText` · `readBuffer` · `writeText` · `writeBuffer` ·
`readStream` · `writeStream` · `mkdir` · `remove` · `rename` · `hostPath`.

Seeds `Documents`, `Pictures`, `Desktop` on first use. Paths are POSIX‑style and
absolute within the root (e.g. `/Documents/a.txt`). A `VfsEntry` is
`{ name, path, type: "file"|"dir", size, modified }`.

`readStream`/`writeStream` exist so large files never have to be buffered whole
in memory (e.g. serving/accepting a multi-hundred-MB file). `writeStream`
returns `{ stream, done }` — always await `done`, not the stream's own
`finish` event: for an unmounted path the write goes to a temp file first and
`finish` fires before the atomic rename over the real target, so `done` is
what actually means "durably persisted at this path" (same write-temp-then-
rename discipline as `writeFileAtomic`, just spread across a stream). A mounted
path (`/Specs`, `/Docs`, `/Templates` — `FSBackend` has no streaming surface,
those stores are never huge) buffers the stream and delegates to the backend's
own `writeBuffer`/`readBuffer` instead; still correct, just not memory-saving
for that subtree.

`hostPath(vfsPath)` returns the validated real filesystem path backing a VFS
path (refusing escapes, same as every other op) — used internally where a
subsystem must operate at the host level (`run_command`'s bind mounts, memory/
scheduler lock-file stats). Not exposed over HTTP.

---

## HTTP surface

| Route | Methods | Purpose |
|---|---|---|
| `/api/fs` | GET (`op=list\|read`), POST (`op=write\|mkdir\|delete\|rename`) | VFS operations |
| `/api/fs/raw` | GET `?path=`, PUT `?path=` | Streamed raw file bytes — GET serves (images, etc.), PUT accepts a streamed upload; neither buffers the whole file |

Client helpers live in `src/lib/os-client.ts` (`fsClient.list/read/write/mkdir/
remove/rename/rawUrl`).

**Why this matters beyond the Files app:** a marketplace item's `services/`
facet (background daemon, `user-specs/002-service-daemons`) runs as a plain
Node worker thread, unbundled and outside the `@/` module graph — it cannot
`import "@/os/vfs"` directly. It reaches the VFS the same way any other
external client would: a plain loopback HTTP call to `/api/fs`/`/api/fs/raw`
on `localhost` (not a browser request, so none of the same-origin/CORS
sandboxing that applies to iframe apps is relevant). Small/metadata operations
(list, stat, mkdir, delete, rename, small read/write) go through `/api/fs`;
large file transfers go through `/api/fs/raw`'s streaming GET/PUT. See the
Build Studio skill's `references/target-marketplace-item.md` (`seed/skills/
build-studio/`) for the full guidance a spec/plan should follow here.

---

## Consumers

- The **Files** app (`src/apps/files/index.tsx`) is a thin UI over `fsClient`.
- **Conversations** (`src/lib/agent/conversations.ts`) store chat threads at
  `/Documents/Chats/<id>.json` through `fsClient`.
- **Workflows** (`src/lib/workflows/store.ts`) store under `/Workflows/`.
- Sub‑agents get VFS tools (`file_list`/`file_read`/`file_write`/`file_mkdir`)
  as their **default** toolset — see
  [Sub‑agents](../assistant/sub-agents-and-delegation.md).

---

## Critical rule

The file tools (`file_list`/`file_read`/`file_write`) and the Files app **only see
`data/vfs`**. To change BOS, edit `src/` (via the developer agent's own tools or
the repo‑scoped dev tools), **never** through the VFS. Don't hunt for BOS code in
the VFS — it isn't there.
