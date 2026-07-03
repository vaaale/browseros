# OS shell: the Virtual File System (VFS)

`src/os/vfs.ts` is the user's sandboxed storage, rooted at `data/vfs`. **It is not
BOS source** — it can never see or edit the repo.

---

## Module (`src/os/vfs.ts`, server‑only)

Rooted at `dataDir()/vfs` with `resolveSafe()` refusing path escapes. Exposes:

`list` · `stat` · `readText` · `readBuffer` · `writeText` · `writeBuffer` ·
`mkdir` · `remove` · `rename`.

Seeds `Documents`, `Pictures`, `Desktop` on first use. Paths are POSIX‑style and
absolute within the root (e.g. `/Documents/a.txt`). A `VfsEntry` is
`{ name, path, type: "file"|"dir", size, modified }`.

---

## HTTP surface

| Route | Methods | Purpose |
|---|---|---|
| `/api/fs` | GET (`op=list\|read`), POST (`op=write\|mkdir\|delete\|rename`) | VFS operations |
| `/api/fs/raw` | GET `?path=` | Raw file bytes (images, etc.) |

Client helpers live in `src/lib/os-client.ts` (`fsClient.list/read/write/mkdir/
remove/rename/rawUrl`).

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
