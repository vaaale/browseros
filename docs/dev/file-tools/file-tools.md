# File tools — the agent's VFS surface

The eleven `file_*` tools are how an agent reads and writes the **user's virtual
file system**. They are the most-called tools in BOS and the ones a change is
most likely to break subtly, because a VFS path is not just a path: depending on
where it points, the same call can hit a plain directory, a git-backed spec
store coupled to a feature branch, or a read-only overlay.

This page is the reference for that behaviour. **Read it before adding a file
tool, changing one, or changing anything under `src/os/vfs.ts`.**

| | |
|---|---|
| Implementation | [`src/lib/assistant/tools/server/files.ts`](../../../src/lib/assistant/tools/server/files.ts) |
| VFS core | [`src/os/vfs.ts`](../../../src/os/vfs.ts) — mount dispatch, path jail, atomic writes |
| Feature scope | [`src/lib/specs/feature-context.ts`](../../../src/lib/specs/feature-context.ts) |
| Capabilities | [`src/lib/agent/capabilities-registry.ts`](../../../src/lib/agent/capabilities-registry.ts) (group `files`) |
| Tests | `tests/assistant/file-tools/_contract.ts` + the three `file-tools-*.test.ts` files |
| User-facing | [Working with your files](../../usage/file-tools/working-with-your-files.md) |

---

## 1. The one structural rule

> **Every VFS tool is a server tool.** There is no frontend file tool, and
> adding one is a bug.

A frontend tool is dispatched to an attached browser and executed there. That is
correct for things that only exist in a browser — opening a window, changing the
wallpaper, rendering a preview. It is wrong for the VFS, for one decisive
reason: **a frontend tool cannot run without a browser.**

`headlessGate()` ([`src/lib/agent/subagents/ephemeral-tools.ts`](../../../src/lib/agent/subagents/ephemeral-tools.ts))
filters a headless run's allowlist down to server-executable tools, because
`awaitFrontendResult` is hard-wired to `{kind:"timeout"}` when no page is
attached. So a frontend-execution file tool is silently unavailable to every
headless agent — Build Studio, the self-heal spine, the scheduler, any
`runLocalHeadless` sub-agent.

This is not hypothetical. The six CRUD tools were frontend tools until they were
moved, and the consequences were:

- **EHS-0026.** A self-heal run on the production box made 69 tool calls over
  2.3 hours — 37 × `file_search`, 12 × `web_search`, and `file_write` *never
  once*, because the gate had stripped it while `find_tools` (which reads the
  persisted `AGENT.md`, not the enforced gate) kept advertising it. The agent
  was reaching for a tool it could not call, and had no way to learn that.
- **A class of self-heal case that could not be fixed at all.** Fixing BOS core
  requires creating `spec.md` files; with no `file_write`, a headless run
  structurally could not.
- **A bridge that fixed half of it.** ADR-12 added
  `bridgeEphemeralFrontendTools`, which swapped the declared frontend VFS tools
  for server-side equivalents — but only for **ephemeral** agents. Named
  headless agents, which is what Build Studio is, kept the hole.

The move deleted the bridge rather than widening it. One implementation, server
side, for every caller.

### What the browser round-trip actually was

Worth stating plainly, because "it was a frontend tool" sounds like it did
something in the frontend. It did not. The handler was:

```ts
file_write: async ({ path, content }, { conversationId }) => {
  await fsClient.scoped(conversationId).write(String(path), String(content));
  return `Wrote ${path}.`;
}
```

`fsClient.scoped()` issues a `fetch` to `/api/fs`, whose route handler is a thin
wrapper that binds the feature scope and calls `vfs.writeText`. So the work
always happened on the server; the browser was a relay. The tools were frontend
tools for historical reasons only — they predate the server tool layer by about
two weeks (`frontend-declarations.ts` 2026-07-10, `server/files.ts` 2026-07-26).

`/api/fs` still exists and is still the right thing for **UI** code — the Files
app uses it. It is simply no longer on the agent tool path.

---

## 2. The tools

All eleven live in `fileTools()` and are spread into `assistantTools()`. Every
one is wrapped by `serverTool()`, so **`execute()` never throws**: a failure
comes back to the model in-band as `Error: <tool>: <message>`.

### 2.1 CRUD

| Tool | Parameters (required in **bold**) | Returns on success |
|---|---|---|
| `file_list` | `path` (default `"/"`) | JSON array of `{name, path, type, size}` |
| `file_read` | **`path`** | the file's text |
| `file_write` | **`path`**, **`content`** | `Wrote <path>.` |
| `file_mkdir` | **`path`** | `Created folder <path>.` |
| `file_delete` | **`path`** | `Deleted <path>.` |
| `file_rename` | **`path`**, **`to`** | `Renamed <path> to <to>.` |

Behaviour that is **contract**, not incidental:

- **`file_list` strips `modified`.** `VfsEntry` carries an mtime; the tool drops
  it. A per-call-varying timestamp turns every listing into a cache-buster and
  pure diff noise in conversation replay. Do not add it back.
- **`file_list` sorts directories first**, then by name (from `vfs.list`).
- **`file_write` creates missing parents** (`writeFileAtomic` does
  `mkdir -p` on the dirname) and **overwrites**, never appends.
- **`file_write` is atomic** — temp file in the same directory, `fsync`, then
  `rename` over the target. This is the discipline DataFS hardlink isolation
  depends on; a plain `writeFile` here breaks clone isolation.
- **`file_mkdir` is recursive and idempotent.** Agents re-issue it freely.
- **`file_delete` is recursive** for folders, and **refuses the VFS root**.
- **`file_rename` creates the target's parent** and **refuses to cross a mount
  boundary** (see §4).
- **Missing paths are errors, not empty values.** `file_read` on a missing file
  reports ENOENT; it does not return `""`. `file_list` on a missing directory
  errors; it does not return `[]`. A swallowed error that yields a plausible
  value is the worst failure mode this codebase has (AGENTS.md §1.2) — an agent
  told a file is empty will happily overwrite it.

### 2.2 Structural edits

| Tool | Parameters | Notes |
|---|---|---|
| `file_edit` | **`path`**, **`find`**, **`replace`** | `find` must occur **exactly once**; 0 or >1 is an error, not a guess |
| `file_patch` | **`path`**, **`hunks[]`** of `{find, replace}` | Ordered, all-or-nothing; each hunk must be unique *when it applies* (a later hunk sees earlier results) |

Prefer these over read-modify-`file_write` for edits to an existing file: they
fail loudly on an ambiguous match instead of silently rewriting the wrong
region, and `file_patch` never leaves a half-applied file.

### 2.3 Search

| Tool | Parameters | Scope | Bound |
|---|---|---|---|
| `file_search` | **`path`** (dir), **`query`**, `glob` | subtree walk, case-insensitive, `SEARCHABLE_EXT` only | 5 000 files / 200 matches |
| `file_grep` | **`path`** (file), **`pattern`**, `ignoreCase`, `context` | one named file, any extension | 200 matches, 200 chars/line |
| `file_glob` | **`path`** (dir), **`pattern`** | subtree walk | 20 000 files / 500 results |

`file_search` and `file_grep` are deliberately two tools (043-file-grep) —
see [actions & tools](../assistant/actions-and-tools.md#content-search-file_grep-one-file-vs-file_search-a-subtree)
for the split and the alias reasoning.

Note the asymmetry, which is intentional and load-bearing: **`file_search`
returns `[]` for a non-directory target** (the walk's `readdir` failure is
swallowed in `walkFiles`), while **`file_grep` errors explicitly**. The silence
is historical behaviour other agents depend on; `file_grep` exists partly to
give the loud alternative.

---

## 3. What these tools do NOT see

`file_*` sees `data/vfs` — the user's sandbox — and nothing else. In particular
it **cannot see BOS's own source**. Every CRUD description says so, and that is
deliberate: an agent that believes otherwise hunts for `src/` in `/Documents`,
finds nothing, and concludes the code is missing.

| To reach | Use |
|---|---|
| BOS's own source (`src/`) | the repo-scoped dev tools, jailed by `src/lib/dev/repo-fs.ts` — reached by delegating to the developer sub-agent |
| A marketplace item's spec | `app_spec_write` / the item spec tools (`tools/server/specs.ts`) |
| A spec store | `/Specs/...` through these tools, under an active feature branch (§5) |

---

## 4. The VFS model underneath

`vfs.ts` dispatches every call through a **mount table** before falling back to
plain filesystem behaviour. A tool never needs to know which case it is in —
that is the whole point of the abstraction — but you do, when changing one.

### Mounts

| VFS prefix | Backend | Writable |
|---|---|---|
| `/Specs/user-specs` | `SpecFS` | yes, **branch-coupled** |
| `/Specs/bos-system-specs` | `SpecFS` | **no** — read-only outright |
| `/Docs` | `DocsFS` | yes, branch-coupled |
| `/Methods/<id>/templates` | `ReadonlyFS` | no |
| everything else | plain `data/vfs` | yes |

Mount *ancestors* (`/Specs`, `/Methods`) are not themselves mounts; `vfs.list`
synthesises their children from the mount table so browsing finds them.

### The path jail

`resolveSafe()` normalises a POSIX path and refuses anything resolving outside
the root. Traversal is therefore not an escape but a **no-op**:
`/Documents/../../../etc/passwd` normalises to `/etc/passwd` *inside the VFS
root*. Mounted backends jail independently via `jailResolve` (`LocalFS`).

### Cross-mount renames

`vfs.rename` refuses when the two paths resolve to different backends (or one is
mounted and the other is not) — `Cannot rename across a VFS mount boundary`. A
git-backed store and a plain directory are not one filesystem, and a silent
`fs.rename` between them would corrupt. Refusing is the correct behaviour;
a future "copy then delete" implementation must be an explicit, separate tool.

### Canonical subpaths

`Documents/Chats` is rooted in `BOS_CANONICAL_DATA` rather than the per-version
data dir, so conversation history written while viewing a preview survives that
preview's clone being discarded. Anything else added to `CANONICAL_SUBPATHS`
gets the same treatment.

---

## 5. Feature scope — the rule most likely to be got wrong

**Every tool in `files.ts` must run its VFS work inside `inScope(ctx, …)`.**

```ts
function inScope<T>(ctx: ToolContext, fn: () => Promise<T>): Promise<T> {
  return withFeatureScope({ conversationId: ctx.conversationId }, fn);
}
```

`withFeatureScope` binds the calling conversation into an `AsyncLocalStorage`
that `getActiveBranch()` reads. `SpecFS` and `DocsFS` resolve their root from
it:

- **Write, branch active** → the branch's worktree.
- **Write, no branch** → `SpecFSNoContextError` ("No active feature context…").
  Refused, never redirected to base.
- **Write, non-writable store** → `SpecFSReadOnlyError`, *regardless of branch*.
  A branch is not a way into `bos-system-specs`.
- **Read, branch active** → the branch's worktree if materialised, else base.
- **Read, no branch** → base checkout.

A tool that forgets the wrapper does not fail loudly. It gets the *silent* half
of the failure matrix: every `/Specs` write throws "no active feature context"
even though the conversation has a branch, and every `/Specs` read quietly
resolves to base — so the branch's content is simply invisible. That is why the
wrapper is a shared helper rather than a line repeated eleven times.

The scope is **per conversation**, never a process global. `ctx.conversationId`
is the only channel an agent tool has; an explicit `branch` override exists on
`FeatureScope` but is for apps (via the `x-bos-feature-branch` header on
`/api/fs`), not for tools.

Writes through `SpecFS` are **debounced and auto-committed** (2 s) on the
feature branch, with a startup sweep recovering anything left uncommitted by a
crash. A tool does not manage that and must not try to.

---

## 6. Execution semantics

**Errors are in-band.** `serverTool()` catches and returns
`` `Error: ${name}: ${e.message}` ``. Do not add a `try/catch` inside a tool body
to produce a friendlier message unless you are adding *information*; swallowing
the cause is banned (AGENTS.md §1.2).

**Parallel safety is an allowlist.** Wrap a tool in `parallel()` only if it is
safe alongside a copy of *itself* and alongside its neighbours.

| Parallel-safe | Sequential |
|---|---|
| `file_list`, `file_read`, `file_search`, `file_grep`, `file_glob` | `file_write`, `file_mkdir`, `file_delete`, `file_rename`, `file_edit`, `file_patch` |

Readers are stateless; two concurrent writes to one path are exactly the race
the split prevents. **Never mark a writer parallel-safe.**

**Gating.** Ids come from the capability registry (group `files`). All eleven
are `context: "both"` — one id on both the main-chat and delegated-sub-agent
surfaces. `file_delete` is additionally in the destructive-tools list.

---

## 7. Recipe — adding a VFS tool

1. **Implement it in `files.ts`.** `serverTool(name, description, schema(...), fn)`,
   with the body wrapped in `inScope(ctx, …)`. Wrap in `parallel()` **only** if
   it is read-only.
2. **Never declare it in `frontend-declarations.ts`.** §1. A tool declared in
   both places is shadowed by registry spread order — a bug whose symptom is
   "works in chat, times out in Build Studio".
3. **Add a capability** in `capabilities-registry.ts`: group `files`,
   `context: "both"`, a real description, and `aliases` for vocabulary a user
   would plausibly use. Add to the destructive list if it destroys data.
4. **Go through `vfs.*`, never `fs.*`.** Reaching for `node:fs` bypasses the
   mount table, the path jail, and atomic writes in one move. If you need a host
   path for a genuine reason (bind-mounting a sandbox), `vfs.hostPath()` is the
   only sanctioned way and it still jails.
5. **Add a scenario to `tests/assistant/file-tools/_contract.ts`**, not a
   bespoke test — §8.
6. **Update this page and the [usage page](../../usage/file-tools/working-with-your-files.md).**

### Things that are not new tools

- A new *spec* operation → the spec/item tools, or `applyWorkflowEdit`. There is
  exactly one structural spec-edit function.
- A new *source* operation → the repo-scoped dev tools.
- "`file_write` but for binary" → `vfs.writeBuffer` exists; a tool would need a
  transport for bytes the model cannot produce. Think before adding it.

---

## 8. Testing

The three test files share **one** scenario suite, on purpose:

```
tests/assistant/file-tools/_contract.ts       the scenarios + the driver interface
tests/assistant/file-tools-server.test.ts     drives fileTools()
tests/assistant/file-tools-frontend-path.test.ts   drives /api/fs (the Files-app path)
tests/assistant/file-tools-parity.test.ts     declarations, gating, parallel-safety
```

Why shared: the claim these tests exist to defend is one of **equivalence** —
the agent path and the UI path must touch the VFS identically. Two
independently-written suites can both pass while testing different things, which
is how a migration loses a branch-coupling rule with nothing going red.

**A driver adapts calling conventions only.** It maps `(op, args,
conversationId)` onto its implementation and normalises the outcome. It must
never reimplement a rule the tool owns — no path normalisation, no scope
resolution, no error classification — or a scenario will pass against an
implementation that does not enforce it.

Adding a scenario covers both paths at once. The environment helper
(`setupScenario`) gives you a sandboxed data dir, real `SpecFS` backends mounted
at the real `/Specs/...` prefixes, and `setActiveBranch()` to move in and out of
a feature context.

Two traps it already handles, which will bite a new scenario written from
scratch:

- **`ensureSystemMounts()` latches per worker.** `setupScenario` calls
  `vfs.list("/")` *first* so the production registration fires and latches, then
  re-registers over it. Registering first just gets overwritten, and the
  scenario silently runs against the real spec root.
- **`ensureVfs()`'s `seeded` flag also latches per worker.** In a worker that
  already ran a VFS test, `Documents`/`Pictures`/`Desktop` are never created for
  *your* data dir. Never assert on the seeded tree; create your own marker.

Cleanup unregisters the mounts — Playwright reuses workers across files, and a
mount pointing at a deleted temp dir surfaces as an inexplicable failure
somewhere else.

---

## 9. Related

- [Actions & tools](../assistant/actions-and-tools.md) — the tool layer overall
- [Virtual file system](../os-shell/virtual-file-system.md) — the VFS itself
- [Sub-agents & delegation](../assistant/sub-agents-and-delegation.md) — headless runs
- [Self-healing](../self-healing/self-healing.md) — EHS-0026's home
- [Testing](../testing.md) — suite conventions
