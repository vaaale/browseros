# Git conflict resolution (035)

**Spec**: `user-specs/core-platform/035-spec-promote-conflict-escalation/`

BOS operates on several git repos — its own source, each spec store, `user-apps`,
and any VFS-mounted repo. When a merge or rebase in one of them conflicts and the
deterministic steps can't fix it, the operation does **not** stop with a
"resolve manually" message. It creates a durable **resolution session**, hands it
to a **conflict-resolution agent** working inside that repo, and opens the Build
Studio **conflict pane** so you can answer the agent when it genuinely can't
decide something.

The invariant behind all of it: **no git conflict path in BOS dead-ends without
an agent** (FR-016). There's an executable check for that in
`tests/gitops/conflict-callsites.test.ts` — it greps the whole source for the
old dead-end shapes and for `merge --abort` sites that never reach the pipeline.
If you add a new conflict-capable operation and don't route it through
`reconcile()`, that test fails.

---

## The shape of it

```
detection ──▶ reconcile() ──▶ session ──▶ agent ──▶ (asks you?) ──▶ complete op
   (any repo)     │              │           │            │              │
                  │              │           │            │              └─ merge committed,
                  │              │           │            │                 base fast-forwarded
                  │              │           │            └─ Build Studio conflict pane
                  │              │           └─ conflict_* tools, scoped to this repo
                  │              └─ data/gitops/sessions/<id>.json (survives restart)
                  └─ rollback tag FIRST, always
```

### 1. `reconcile()` — the one pipeline

`src/lib/gitops/reconcile.ts`. Five steps, unchanged in shape since 001:

1. **rollback tag** — `bos/pre-reconcile-<stamp>`, before anything is touched.
2. **remote sync** (only when a `remote` is given).
3. the configured **merge strategy**.
4. a scripted **rebase fallback**.
5. **escalate** — this is what 035 generalized.

Step 5 now: reads the configured agent, captures the conflict snapshot from
refs, creates the session, tags the conversation, emits the auto-launch event,
starts the run, and waits for the **session** (not the run) to settle.

### 2. The working context — the only per-repo variable

```ts
interface WorkContext {
  repoKind: "source" | "user-specs" | "user-apps" | "vfs-mount" | "generic";
  repoPath: string;   // the working tree the agent operates in
  repoRoot: string;   // differs for a linked worktree
  baseRef: string;    // merge-base sha ("" when there is none)
  oursRef: string;    // the branch being reconciled onto
  theirsRef: string;  // the ref being merged in
  mode: "working-tree" | "plumbing";
  label: string;      // what the pane shows
}
```

This object is the *whole* of the per-repo variation. The access mechanism is
identical everywhere: the agent reads and writes through `conflict_*` tools that
take a `repo_path`. There is deliberately **no** `if (repoKind === …)` anywhere in
the tools or the store — adding a new repo kind means passing a different
`WorkContext`, nothing else.

`mode: "plumbing"` is for the case with no live checkout to write into — a
coupled repo whose primary checkout is on a detached HEAD, so there is no branch
to merge into directly. (Until app-candidate was retired this also covered that
second scheme holding `user-apps`'s primary checkout.) There, steps
2–4 are skipped entirely — they all operate on a working tree — and the
resolutions are landed with `commit-tree` + `update-ref`, leaving the live
checkout untouched.

### 3. The snapshot comes from REFS, never from merge stages

This one bites if you forget it. Steps 3–4 **abort** the merge before step 5
runs, so `git show :1:` / `:2:` / `:3:` no longer exist by the time a session is
created. The snapshot records three refs instead:

- `base` = `git merge-base <ours> <theirs>`, `ours` = the branch, `theirs` = the source ref.
- Per file: `readFileAtRef(repoPath, ref, rel)` (`src/lib/gitops/git-ops.ts`).
- **add/add**: the file doesn't exist at the merge base, so `git show <base>:<rel>`
  fails — `readFileAtRef` returns `null` and the pane renders "base: (empty)".
  This is the reported repro's exact shape, so that catch is on the critical path.

Refs also survive a process restart, which is what makes a session genuinely
resumable: the three-way content is re-derived, not re-stored.

The marker view the pane shows is produced on demand by `git merge-file --diff3`
over those three contents — real hunks, from a merge that no longer exists.

### 4. The session

`data/gitops/sessions/<id>.json`, atomic writes, plus a `globalThis` warm index.
Runtime state, so: not the VFS (that's the user's sandbox), not a spec store
(it must not be branch-coupled).

```
working ──agent asks──▶ awaiting-user ──user answers──▶ working
   │                          │
   └──▶ resolved | failed | timed-out | abandoned ◀─────┘
```

`awaiting-user` is **not** terminal and waits **indefinitely**. The 25-minute
budget applies only to continuous `working` time (`lastWorkingAt` resets on every
transition into `working`), so a session parked overnight is never timed out.

### 5. Park-and-rewake, not a blocked run

When the agent calls `conflict_decision`, its run **ends**. It does not sit on a
blocked promise waiting for you.

That's deliberate. A blocked run is in-memory: it can't survive a restart, and it
pins the conversation's only run slot for as long as you take to answer — which
is unbounded by design. Instead:

1. `conflict_decision` records the question, parks the session, returns
   `{ parked: true }`, and the agent ends its turn.
2. You answer in the pane (or the chat — same route, same code path).
3. `answerDecision` records it, flips the session back to `working`, and starts a
   **new run on the same conversation** whose first message *is* your answer.

The transcript is continuous, so the agent keeps all its context. "Continues the
same run" is satisfied at the conversation level, which is what the user
actually experiences.

### 6. Completing the operation

Resolving the session is what finishes the underlying operation — that's the
point of `SessionCompletion`, captured at creation time so it works even when the
detector was the Supervisor (a different process):

- `merge` — re-run the merge in `repoPath`, overwrite the conflicted paths with
  the resolutions, commit. If the tree is already clean and merged (the source
  path, where the agent resolves via `dev_delegate` and commits itself), the
  merge is skipped and only the follow-on steps run.
- `ff` — fast-forward `baseBranch` onto the reconciled branch. This is why base
  is never left conflicted: the conflict only ever existed on the working
  branch, and base only ever moves by a fast-forward.
- `pruneWorktree` — drop the linked worktree (the spec-promote flow).
- `plumbing-merge` — `commit-tree` + `update-ref`, no checkout touched.

Failure at any point settles the session `failed` **with the rollback tag** — never
a silent success.

---

## The agent's tools

`src/lib/assistant/tools/server/conflict-resolve.ts`. All server-side, all
scoped to the session's own repo.

| Tool | What it does |
|---|---|
| `conflict_read` | ours / base / theirs content + marker hunks. Binary files return `binary: true` and no content. |
| `conflict_write` | the full merged file, markers removed. Refuses content that still has markers. |
| `conflict_decision` | ask the user. **Parks the session and ends the turn.** |
| `conflict_status` | what's resolved, what's left, the decision timeline. |
| `conflict_complete` | declare it resolved → completes the operation. Refuses while anything is open. |
| `conflict_abandon` | give up honestly → rolls back to the tag. |

**How a tool knows which session it's in**: `ToolContext` carries only a
`conversationId`. The escalation writes `conflictSessionId` as a top-level field
on the conversation file (exactly like the existing `activeFeatureBranch`), and
each tool reads it back via `getConversationConflictSessionId`. That field
survives the park→rewake boundary because `saveConversationMessages` preserves
top-level fields.

**Access control**: every call validates `repo_path === session.workContext.repoPath`.
The agent can only ever touch this session's repo.

**Loud failure (FR-021)**: the first call also verifies the context is genuinely
usable — a real git dir, a writable tree. If not, the session fails with a clear
message and the rollback tag rather than pretending to work.

**Binary (FR-022)**: `conflict_read` reports `binary: true` and returns no
content; `conflict_write` refuses outright. The agent surfaces it instead. A
waived file also makes `conflict_complete` fail — a conflict you didn't resolve
must not complete the operation.

### Giving another agent the job

`Settings → Build Studio → Conflict agent` (`build-studio.conflictAgent`,
default `devops`). Read on **every** escalation, so a change takes effect with
no reload.

The selected agent must list the six `conflict_*` ids in its allowlist — `gate.ts`
only offers a run the tools its agent declares. The Settings dropdown warns when
the selected agent lacks them. The seeded `devops` agent has them, and
`backfillConflictTools` in `src/lib/agent/subagents/store.ts` adds them (once,
additively) to a `data/agents/devops/AGENT.md` left over from an older install —
without that, an upgrade would silently break every escalation.

---

## Auto-launch

`escalate()` emits `com.bos.gitops.conflict.escalated` with
`{ sessionId, repoLabel, featureBranch, rollbackTag, repoKind }`.

Build Studio declares a UI handler for it in its manifest, plus an
`eventNamespaces: ["com.bos.gitops.*"]` grant (the event is emitted by gitops,
outside BS's own `com.bos.build-studio.*` root).

034's UI handlers are *click*-resolved; a conflict must not wait for a click. So
`src/components/desktop/ConflictLaunch.tsx` (a sibling of `EventBell` in the
topbar) subscribes to the event stream and calls
`launch("build-studio", { pane: "conflict", sessionId })`. Two guards matter
there:

- **ignore replayed history** — the stream replays from the beginning, and
  re-launching the pane for a long-settled conflict every time you open a tab
  would be maddening. Only events newer than the subscriber's mount count.
- **restore on mount** — instead, it queries the session store once on mount and
  opens the pane if a session is still non-terminal. That covers a browser
  refresh (windows don't survive a reload) and a first tab opened after a
  restart, and it needs no event at all.

Re-launching is idempotent: BS is a singleton, so `launch` focuses it and merges
`params`.

## Restart recovery

`recoverSessions()` (`src/lib/gitops/sessions/recover.ts`), called from
`src/instrumentation.ts` after the event kernel starts:

- **`working`** — its run died with the process (`runManager` is empty on boot).
  Re-launch on the same conversation, telling the agent to call `conflict_status`
  first so it doesn't redo finished work.
- **`awaiting-user`** — restore only. It's parked on you; re-launching would be
  the agent talking to itself. It re-wakes when you answer.

Both then re-emit the event.

> This re-emit is **not** `redispatchPendingOnBoot`, and can't be.
> That mechanism re-enqueues *pending* events to *headless* handlers — and this
> event has no headless handler, so the kernel settles it
> `processed/no-active-handlers` the instant it's emitted. It is never "pending".
> The explicit emit in the sweep is the only thing that works.

## Call sites

Every conflict-capable operation in BOS, and where it now goes:

| # | Site | Repo | Was |
|---|---|---|---|
| 1 | `coupledConflicts` pre-check → `resolveCoupledConflicts` (`tools/supervisor/lib/coupled-repos.mjs`) | spec stores + user-apps | `throw "promote blocked — …"` (**the reported bug**) |
| 2 | `promoteCoupled` (same file) | spec stores + user-apps | `merge --abort` + "merge manually in \<root\>" |
| 3 | `appPromote` (`tools/supervisor/lib/app-candidate.mjs`) | user-apps | raw `git merge`, threw on conflict — path retired; user-apps now merges only via `promoteCoupled` (row 2) |
| 4 | `promoteFeature` (`src/lib/specs/promote.ts`) | user-specs | `merge --abort` + `{ kind: "conflict" }` |
| 5 | `case "fetch"` (`src/app/api/git-remotes/route.ts`) | any managed repo | `rebaseConflict: true`, "resolve manually, or force-push" |
| 6 | `case "push"` recovery (same file) | any managed repo | same |
| 7 | `resolveConflict` via `/api/git-sync` `resolve` | VFS mount | aborted and threw — **found by the completeness sweep**, not in the original list |

The three Supervisor sites reach the pipeline over the existing loopback HTTP to
`/api/gitfs/reconcile`. The Supervisor never imports BOS `@/` source and never
hard-codes a BOS path — everything repo-specific travels as the working context.

### Adding a new one

```ts
const outcome = await reconcile({
  repoPath,                  // the working tree
  sourceRef,                 // what's being merged in
  strategy: "merge",
  repoKind: "vfs-mount",     // labelling only
  repoRoot, repoLabel,
  mode: "working-tree",
  operationLabel: "mount sync",   // shown in the pane
  escalationContext: "…what led here…",
  completion: { kind: "merge", strategy: "merge" },
});
// outcome.sessionId / .devopsConversationId when it escalated (FR-018)
```

Then surface `outcome.sessionId` in your response, and render
`<ConflictSessionBadge sessionId={…} />` wherever the user triggered it. That's
the whole integration.

## Surfaces

`src/components/gitops/ConflictSessionBadge.tsx` is the single indicator — live
status, unresolved file count, rollback tag, and an "Open resolution" button
into the pane. Used by `VersionControls`, `VersionsTab`,
`ConflictResolutionDialog` and `GitRemotesTab`, so those four can't drift apart
the way their hand-written dead-end strings did.

## API

| Route | Method | Purpose |
|---|---|---|
| `/api/gitops/sessions` | GET | list non-terminal (`?status=all` for everything) |
| `/api/gitops/sessions?id=` | GET | one session |
| `/api/gitops/sessions?id=&file=` | GET | that file's three-way content + hunks |
| `/api/gitops/sessions?id=` | PATCH | `{action:"answer"\|"abandon"}` — the only client mutation |
| `/api/gitops/sessions?id=` | DELETE | abandon + roll back |

The client never runs git. It sees the serialized session and can answer a
decision or abandon; everything else is server-side.

## Gotchas

- **`git` reports conflicts on stdout, not stderr.** `isMergeConflict(stderr)`
  alone misclassifies a plain merge conflict as a hard failure — which returns
  `failed` and never escalates, quietly defeating the whole invariant. Check both.
- **BOS-created repos have no git identity.** `git init` with no `user.email`
  makes `tag -a`, `commit` and `merge` fail outright — including step 1, the
  rollback tag. `gitIdentityEnv(repoPath)` supplies a fallback identity only when
  none is configured.
- **`conflict_write` puts content in the live tree**, so completion restores
  those paths to HEAD before re-running the merge (git refuses to merge over
  locally-modified files). The resolutions live on the session, so nothing is lost.
- **The pipeline's own `.git-lock`** shows up in `git status --porcelain` while an
  operation holds it. Filter it before asserting a tree is clean.

## Tests

- `tests/gitops/conflict-snapshot.test.ts` — refs-based reads, the add/add null
  base, merge-tree parsing, marker rendering.
- `tests/gitops/conflict-session-store.test.ts` — the state machine, durability
  across a simulated restart, decision answering, completion (merge / ff /
  plumbing), rollback, the binary refusal, the concurrent-op guard, the boot sweep.
- `tests/gitops/conflict-callsites.test.ts` — every conversion, plus the FR-016
  completeness sweep over the whole source.
- `tests/gitops/conflict-agent-config.test.ts` — the configurable agent, tool
  registration/gating, the seed, and the upgrade backfill.
- `e2e/035-conflict-resolution.spec.ts` — the quickstart scenarios in a browser,
  against real temp git repos.
