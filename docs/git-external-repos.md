# External Git Repository Integration

BrowserOS can register external git remotes, push to multiple remotes simultaneously, mount remote repositories into the VFS, and authenticate via OAuth (GitHub/GitLab), personal access tokens, or SSH keys.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Agent Tools](#agent-tools)
- [Settings UI](#settings-ui)
- [Configuration](#configuration)
- [OAuth Setup](#oauth-setup)
- [Auto-push](#auto-push)
- [Conflict Resolution](#conflict-resolution)
- [Security](#security)
- [Troubleshooting](#troubleshooting)

## Overview

The external repository integration lets users:

1. **Register external git remotes** — point a local repo at GitHub, GitLab, or any git-over-HTTPS/SSH server.
2. **Push to multiple remotes** — push the current branch to one or all registered remotes in a single operation.
3. **Mount remote repos into the VFS** — clone a remote branch into `data/vfs/` so its files appear alongside native VFS content.
4. **Authenticate via OAuth** — connect GitHub/GitLab accounts with PKCE-based OAuth flows; tokens are stored in the encrypted `SecretsStore`.
5. **Sync and resolve conflicts** — detect ahead/behind state, merge, squash-merge, or stash-commit to resolve diverged branches.

## Architecture

### Module Layout (`src/lib/gitops/`)

There are 8 modules with no barrel file — each is imported directly.

| Module | Lines | Responsibility |
|---|---|---|
| `git-ops.ts` | 597 | Thin wrappers around the `git` CLI via `child_process.spawn`. Auth and locking are the caller's responsibility. |
| `lock.ts` | 195 | Per-repo serialization of git operations (dual-layer: in-memory queue + `.git-lock` file). |
| `auth.ts` | 203 | Credential resolution from `SecretsStore`, SSH key management, URL token embedding, OAuth refresh. |
| `remote-config.ts` | 80 | CRUD for `data/config/git-remotes.json` — remote metadata (provider, autoPush, timestamps). |
| `mount-manager.ts` | 135 | CRUD for `data/config/git-mounts.json` — mount registry, path validation, bare-cache directory creation. |
| `sync-status.ts` | 194 | Fetch + ahead/behind computation, conflict detection (dry-run merge), conflict resolution (merge/rebase). |
| `auto-push.ts` | 55 | Push to all remotes where `autoPush === true` (excluding `origin`). |
| `logging.ts` | 302 | Structured JSONL logger with rotation, URL sanitization, and sensitive-data redaction. |

### How Locking Works

**File:** `src/lib/gitops/lock.ts`

All git operations on the same repository are serialized through a singleton `GitLock` instance:

- **Dual-layer:** An in-memory `Map<repoPath, LockRecord>` plus a `.git-lock` JSON file in each repo's working directory.
- **Per-repo:** Different repos can operate in parallel; only operations on the **same** repo are queued.
- **30-second timeout:** A lock auto-releases after 30s with a warning log. The timeout is `.unref()`'d so it does not keep the process alive.
- **Stale detection:** If a file lock is older than 30s, it is forcibly removed and the in-memory hold is cleared.
- **Queue-based:** Waiting callers are stored in a per-repo array and woken up when the lock is released.
- **`withLock` convenience:** Acquires lock, runs a callback, releases in `finally` (exception-safe).
- **Release is idempotent:** Double-release is silently ignored.
- **Deadlock prevention:** The lock does NOT enforce ordering across repos. Callers that need shared resources (e.g., bare cache) must acquire locks in alphabetical order of `repoPath`.

### How Auth Works

**File:** `src/lib/gitops/auth.ts`

Credentials are resolved from the encrypted `SecretsStore`:

- **Storage keys:** `git_remote:<remoteName>:<authType>` — one key per auth type per remote.
- **OAuth:** Stored as `{ access_token: string, expires_at: number }`. Tokens are embedded in URLs as `https://oauth2:TOKEN@host/...`.
- **Token (PAT):** Stored as `{ token: string }`. Embedded in URLs the same way.
- **SSH:** Stored as `{ keyData: string, passphrase?: string }`. Written to a temporary file (`data/.ssh-keys/tmp-<ts>-<rand>.key`) with mode `0o600`. A cleanup function deletes the file after use. SSH commands use `StrictHostKeyChecking=no` and `BatchMode=yes`.
- **Protocol rejection:** `git://` URLs are explicitly rejected.
- **Token expiry:** `isTokenExpiringSoon()` returns true if the token expires within 24 hours.
- **OAuth refresh:** `maybeRefreshOAuth()` checks expiry, then calls `OAuthManager.refreshToken()`.

### VFS Mount Paths

**File:** `src/lib/gitops/mount-manager.ts`

- Mount paths **must** resolve within `data/vfs/`. `validateMountPath()` checks that `path.resolve(vfsRoot, mountPath)` starts with `data/vfs/`.
- Bare caches live in `data/.git-cache/<sha256(remoteName).slice(0,16)>/`.
- Symlink escape scanning (`scanSymlinkEscapes` in `git-ops.ts`) recursively walks cloned directories and returns any symlinks pointing outside the root.
- Mount status lifecycle: `syncing` → `synced` (on success) or `error` (on failure).

## Agent Tools

All 12 tools are **server-side only** (no frontend declarations). They are registered in `src/lib/assistant/registry.ts` and implemented across 5 files in `src/lib/assistant/tools/server/`.

### `git_add_remote`

**File:** `src/lib/assistant/tools/server/git-remotes.ts`

Register a new git remote — adds to local git config, stores credentials in `SecretsStore`, persists metadata in `git-remotes.json`.

| Param | Type | Required | Description |
|---|---|---|---|
| `repoPath` | string | yes | Absolute path to local git repo |
| `name` | string | yes | Short name (e.g., `origin`, `upstream`) |
| `url` | string | yes | Remote URL (`https://`, `ssh://`, or `git@`) |
| `authType` | string | yes | `token`, `oauth`, or `ssh` |
| `provider` | string | no | `github`, `gitlab`, or `generic` (auto-detected from URL) |
| `token` | string | no | Credential to store (PAT, OAuth token, or SSH key data) |

**Returns:** `{ name, url, status: "ok", message }`. If the name collides, auto-renames and returns `uniqueName`.

**Errors:** `MISSING_PARAMS`, `INVALID_URL` (git:// rejected), `INVALID_AUTH_TYPE`, `GIT_ADD_REMOTE_FAILED`.

### `git_remove_remote`

Remove a git remote from local config and metadata store. Deletes all stored credentials.

| Param | Type | Required |
|---|---|---|
| `repoPath` | string | yes |
| `name` | string | yes |

**Returns:** `{ status: "ok", message }`.

**Errors:** `MISSING_PARAMS`, `GIT_REMOVE_REMOTE_FAILED`.

### `git_list_remotes`

List all git remotes for a repo, augmented with metadata from `git-remotes.json`.

| Param | Type | Required |
|---|---|---|
| `repoPath` | string | yes |

**Returns:** `{ remotes: [{ name, url, provider, autoPush }] }`.

### `git_list_branches`

List all branches on a remote (via `ls-remote`). Does not need a local repo.

| Param | Type | Required |
|---|---|---|
| `url` | string | yes |
| `authType` | string | yes |
| `token` | string | no |

**Returns:** `{ branches: string[] }`.

**Errors:** `MISSING_PARAMS`, `INVALID_AUTH_TYPE`, `GIT_LIST_BRANCHES_FAILED`.

### `git_push`

Push a local branch to a single remote.

| Param | Type | Required | Description |
|---|---|---|---|
| `repoPath` | string | yes | Absolute path to local repo |
| `remote` | string | yes | Remote name |
| `branch` | string | no | Branch to push (defaults to current) |
| `authType` | string | no | Auth type override |
| `token` | string | no | Inline credential |

**Returns:** `{ status: "success", pushed: true }` or `{ status: "failed", pushed: false, error }`.

### `git_push_all_remotes`

Push the current branch to all remotes (or a subset). Serializes pushes through a single lock.

| Param | Type | Required | Description |
|---|---|---|---|
| `repoPath` | string | yes | Absolute path to local repo |
| `branch` | string | no | Branch (defaults to current) |
| `remotes` | string[] | no | Subset of remote names |
| `authType` | string | no | Auth type override |
| `token` | string | no | Inline credential |

**Returns:** `{ results: [{ remoteName, status, error? }] }`.

### `git_fetch`

Fetch updates from a remote, detect new/updated/deleted branches, and return ahead/behind counts.

| Param | Type | Required | Description |
|---|---|---|---|
| `repoPath` | string | yes | Absolute path to local repo |
| `remote` | string | no | Remote name (defaults to `origin`; use `*` for all) |
| `authType` | string | no | Auth type override |
| `token` | string | no | Inline credential |

**Returns:** `{ status, updates: [{ newBranches, updatedBranches, deletedBranches }], aheadBehind: { ahead, behind } }`.

### `git_mount`

Mount a configured remote to a VFS path. Validates path, registers mount, clones into bare cache.

| Param | Type | Required | Description |
|---|---|---|---|
| `remoteName` | string | yes | Name of a configured remote |
| `mountPath` | string | yes | VFS path (relative to `data/vfs/`) |
| `branch` | string | no | Branch to track (defaults to remote's default) |

**Returns:** `{ status: "success", mountPath, branch }`.

**Errors:** `MISSING_PARAMS`, `MOUNT_PATH_INVALID`, `REMOTE_NOT_FOUND`, `GIT_MOUNT_FAILED`.

### `git_unmount`

Unmount a remote by name.

| Param | Type | Required |
|---|---|---|
| `remoteName` | string | yes |

**Returns:** `{ status: "ok", message }`.

**Errors:** `MISSING_PARAMS`, `NOT_FOUND`.

### `git_list_mounts`

List all mounted remotes. Takes no parameters.

**Returns:** `{ mounts: [{ remoteName, mountPath, branch, status }] }`.

### `git_merge`

Resolve branch conflicts by merging a remote branch. **Requires `confirm: true`** — returns `{ status: "cancelled" }` otherwise.

| Param | Type | Required | Description |
|---|---|---|---|
| `repoPath` | string | yes | Absolute path to local repo |
| `remote` | string | yes | Remote name |
| `branch` | string | yes | Branch to merge |
| `strategy` | string | yes | `merge-squash`, `merge`, or `commit` |
| `confirm` | boolean | yes | Must be `true` to execute |
| `authType` | string | no | Auth type override |
| `token` | string | no | Inline credential |

**Returns:** `{ status: "success", strategy, commitHash, hasLocalChanges }`.

**Errors:** `MERGE_CONFLICT` (with `conflictingFiles` list), `GIT_MERGE_FAILED`.

### `git_sync`

Fetch from a remote, detect diverged state, and optionally auto-resolve.

| Param | Type | Required | Description |
|---|---|---|---|
| `repoPath` | string | yes | Absolute path to local repo |
| `remote` | string | yes | Remote name |
| `branch` | string | yes | Branch to sync |
| `conflictStrategy` | string | no | Auto-resolve: `merge-squash`, `merge`, `commit`, or `abort`. Omit to just detect. |
| `authType` | string | no | Auth type override |
| `token` | string | no | Inline credential |

**Returns:** One of:
- `{ status: "in_sync", branch, ahead: 0, behind: 0 }`
- `{ status: "behind", branch, ahead, behind }`
- `{ status: "conflict_detected", branch, ahead, behind, conflict: { requiresConfirmation: true } }`
- `{ status: "resolved", strategy, commitHash, branch, ahead: 0, behind: 0 }`
- `{ status: "aborted", branch, ahead, behind }`

**Errors:** `MERGE_CONFLICT` (with `conflictingFiles`), `GIT_SYNC_FAILED`.

## Settings UI

### Git Remotes — Settings → Versions

**Component:** `src/components/apps/settings/versions/GitRemotesTab.tsx`

The **Git Remotes** section displays a list of configured remotes. Each remote card shows:
- Name + provider badge (GitHub/GitLab/Generic) + status indicator (connected/error/not-connected)
- Truncated URL
- Last push and last fetch timestamps (relative)
- **Auto-push toggle** (checkbox, toggles immediately)
- Action buttons: **Push**, **Fetch**, **Test**, **Edit**, **Remove**

The **Add Remote** button opens a modal with fields for name, URL, provider (auto-detected), auth type (Token/OAuth/SSH), and optional credential input. The **Edit** modal allows changing provider and auto-push settings.

### Git Providers — Settings → Integrations

**Component:** `src/components/apps/settings/integrations/GitProvidersTab.tsx`

Shows GitHub and GitLab as connectable providers. Each row has:
- Status dot (green = connected, gray = not)
- Provider name and connection status
- **Connect** button (opens OAuth popup)
- **Disconnect** button

### VFS Mounts — Settings → Versions (lower section)

**Component:** `src/components/apps/settings/versions/GitRemotesTab.tsx` (lower half)

Lists mounted remotes with:
- Remote name + mount path + branch + status dot (green=synced, blue=syncing, amber=error)
- Last synced timestamp
- **Sync Now** and **Unmount** buttons

The **Mount from Remote** button opens a modal with remote selector (origin excluded), mount path input, and branch input.

### Branch Sync Status — Settings → Versions

**Component:** `src/components/apps/settings/versions/BranchSyncPanel.tsx`

Displays sync status for all mounted remotes:
- Remote name + branch + color-coded status dot
- Status logic: Conflict (red), Diverged (orange), Behind (amber), Ahead (blue), In sync (green)
- Ahead/behind counts, last fetched/synced timestamps
- **Resolve** button (opens `ConflictResolutionDialog` when conflict is detected)
- **Refresh** button to fetch all

### Conflict Resolution Dialog

**Component:** `src/components/apps/settings/versions/ConflictResolutionDialog.tsx`

A modal with three strategy cards:
1. **Merge --squash** (recommended) — squashes all remote commits into one on top of local
2. **Merge** — standard merge commit preserving full history
3. **Commit** — stashes local, squash-merges remote, commits, pops stash

Plus an **Abort** button. Shows conflicting files list when available.

## Configuration

### `data/config/git-remotes.json`

Array of `GitRemoteConfig` objects:

```json
[
  {
    "name": "upstream",
    "url": "https://github.com/user/repo.git",
    "provider": "github",
    "autoPush": true,
    "defaultBranch": "main",
    "remoteBranch": "main",
    "lastFetched": "2025-01-15T10:30:00.000Z",
    "lastPushed": "2025-01-15T09:00:00.000Z",
    "oauthTokenExpiresAt": 1705312200000,
    "createdAt": "2025-01-10T12:00:00.000Z",
    "updatedAt": "2025-01-15T10:30:00.000Z"
  }
]
```

| Field | Type | Description |
|---|---|---|
| `name` | string | Unique remote name |
| `url` | string | Remote URL |
| `provider` | `"github"` \| `"gitlab"` \| `"generic"` | Auto-detected from URL |
| `autoPush` | boolean | Push to this remote on version promote |
| `defaultBranch` | string? | Default branch of the remote |
| `remoteBranch` | string? | Branch to track for sync |
| `lastFetched` | string? | ISO timestamp of last fetch |
| `lastPushed` | string? | ISO timestamp of last push |
| `oauthTokenExpiresAt` | number? | Unix timestamp of OAuth token expiry |
| `createdAt` | string | ISO timestamp |
| `updatedAt` | string | ISO timestamp |

Writes are atomic (temp file + rename).

### `data/config/git-mounts.json`

Array of `GitMountConfig` objects:

```json
[
  {
    "remoteName": "upstream",
    "mountPath": "Documents/my-repo",
    "branch": "main",
    "status": "synced",
    "lastSynced": "2025-01-15T10:30:00.000Z",
    "createdAt": "2025-01-10T12:00:00.000Z",
    "updatedAt": "2025-01-15T10:30:00.000Z"
  }
]
```

| Field | Type | Description |
|---|---|---|
| `remoteName` | string | Name of a registered remote |
| `mountPath` | string | VFS path (must be within `data/vfs/`) |
| `branch` | string | Branch to track |
| `status` | `"synced"` \| `"syncing"` \| `"error"` | Current sync state |
| `lastSynced` | string? | ISO timestamp of last successful sync |
| `createdAt` | string | ISO timestamp |
| `updatedAt` | string | ISO timestamp |

### OAuth Token Storage

Tokens are stored in the encrypted `SecretsStore` under the `git_remote` namespace:

| Key Pattern | Value | Auth Type |
|---|---|---|
| `git_remote:<name>:oauth` | `{ access_token, expires_at }` | OAuth |
| `git_remote:<name>:token` | `{ token }` | PAT |
| `git_remote:<name>:ssh` | `{ keyData, passphrase? }` | SSH |

Client credentials (for OAuth apps) are stored as:
| Key Pattern | Value |
|---|---|
| `git_remote_oauth` / `github:client` | `{ client_id, client_secret }` |
| `git_remote_oauth` / `gitlab:client` | `{ client_id, client_secret }` |

## OAuth Setup

### Registering OAuth Apps

**GitHub:**
1. Go to GitHub → Settings → Developer settings → OAuth Apps → New OAuth App
2. Set **Authorization callback URL** to `<BOS_BASE_URL>/api/git-remotes/oauth/callback`
3. Copy the Client ID and Client Secret
4. Store them in BrowserOS Settings → Integrations → Git Providers → Connect

**GitLab:**
1. Go to GitLab → Preferences → Applications → New Application
2. Set **Redirect URI** to `<BOS_BASE_URL>/api/git-remotes/oauth/callback`
3. Select scopes: `api`, `read_user`, `read_repository`, `write_repository`
4. Copy the Application ID and Secret
5. Store them in BrowserOS Settings → Integrations → Git Providers → Connect

### OAuth Flow

BrowserOS uses **PKCE (Proof Key for Code Exchange, RFC 7636)**:

1. **Start:** Client opens a popup to `/api/git-remotes/oauth/start?provider=github`.
2. The route generates a `code_verifier` (32 random bytes, base64url) and `code_challenge` (SHA-256), stores them in an in-memory map with a 10-minute TTL, and redirects to the provider's authorization URL.
3. **Authorize:** User approves in the provider's OAuth page.
4. **Callback:** Provider redirects to `/api/git-remotes/oauth/callback?code=...&state=...`. The route exchanges the code + verifier for tokens via `POST` to the provider's `tokenUrl`.
5. **Store:** The access token and expiry are saved to `SecretsStore` under `git_remote:<remoteName>:oauth`. The remote config is updated with `oauthTokenExpiresAt`.
6. **Complete:** The callback returns an HTML page that posts a `bos-git-oauth` message back to the parent window via `window.opener.postMessage()`.

### Token Refresh

- `isTokenExpiringSoon()` returns true if the token expires within 24 hours.
- `maybeRefreshOAuth()` checks expiry, then calls `OAuthManager.refreshToken()` which uses the provider's refresh token flow.
- Refresh is triggered automatically before operations that need auth.

## Auto-push

### How It Works

When a version is **promoted** in the Supervisor, the Supervisor reads the `BOS_PUSH_MODE` environment variable:

| Value | Behavior |
|---|---|
| `manual` (default) | No automatic pushes |
| `auto-on-promote` | Triggers auto-push on promote |

Auto-push (`src/lib/gitops/auto-push.ts`) iterates all remotes where `autoPush === true` and `name !== "origin"`, resolves auth (OAuth for GitHub/GitLab, token for generic), and pushes the current branch.

### Configuration

- The `autoPush` flag is set **per remote** via the UI checkbox in the Add/Edit Remote modal.
- It is stored in `data/config/git-remotes.json` as the `autoPush` boolean field.
- `getAutoPushRemotes(repoPath)` filters the config: `autoPush === true && name !== "origin"`.

### Interaction with `BOS_PUSH_MODE`

If `BOS_PUSH_MODE=off`, the Supervisor skips the promote-push entirely, so `executeAutoPush` is never called regardless of per-remote `autoPush` settings.

## Conflict Resolution

### Conflict Detection

Conflicts are detected in two ways:

1. **Ahead/behind computation** (`sync-status.ts`): After fetching, `git rev-list --left-right --count origin/<branch>...HEAD` returns ahead and behind counts. If both are > 0, the branches have diverged.

2. **Dry-run merge** (`sync-status.ts:hasConflict()`): Runs `git merge --no-commit --no-ff origin/<branch>` then immediately `git merge --abort`. If the merge command exits with a non-zero code, a conflict exists.

### Three Strategies

| Strategy | Description |
|---|---|
| `merge-squash` | `git merge --squash origin/<branch>` — squashes all remote commits into a single commit on top of local changes |
| `merge` | `git merge origin/<branch>` — standard merge commit preserving full history |
| `commit` | AD-002 pattern: stash local → squash-merge remote → commit message → pop stash. Preserves local changes separately. |

### UI Flow

1. The **Branch Sync Panel** shows a conflict indicator (red dot) when both ahead and behind are > 0.
2. The **Resolve** button opens the `ConflictResolutionDialog`.
3. The dialog shows ahead/behind counts, conflicting files list (when available), and three strategy cards.
4. Selecting a strategy dispatches `POST /api/git-sync { action: "resolve", remoteName, strategy }`.
5. On success, the sync status updates. On failure (remaining conflicts), an error is displayed.

## Security

- **SSH keys are never logged.** The `GitLogger` throws if any log entry contains fields named `sshKey`, `sshKeyData`, `sshKeyPath`, `privateKey`, or `private_key`.
- **URLs are sanitized before logging.** Embedded credentials (`user:pass@host`) are replaced with `****@`.
- **Sensitive values are redacted.** All log entries pass through `redactSensitiveStrings()` which replaces values of sensitive keys (`token`, `access_token`, `refresh_token`, `pat`, `password`, etc.) with `[REDACTED]`.
- **Protocol rejection.** `git://` URLs are rejected in `applyAuthToUrl()` and by `git_add_remote` validation.
- **Mount paths stay within `data/vfs/`.** `validateMountPath()` resolves the path and checks it starts with the VFS root.
- **Symlink escape scanning.** `scanSymlinkEscapes()` recursively walks cloned directories and flags symlinks pointing outside the root.
- **Bare cache in `data/.git-cache/`.** Cloned repos are stored in a sandboxed cache directory, separate from the VFS.
- **`GIT_TERMINAL_PROMPT=0`** is always set to prevent interactive credential prompts.
- **SSH `StrictHostKeyChecking=no`** is used only for explicit SSH auth paths (not globally).
- **Log rotation.** Log files are rotated at 10 MB and archived logs are pruned after 7 days.

## Troubleshooting

### Common Errors

| Error Code | Cause | Fix |
|---|---|---|
| `GIT_AUTH_FAILURE` | Invalid or expired credentials | Re-authenticate in Settings → Git Providers. Check token scopes. |
| `GIT_CLONE_FAILED` | Network error or repo doesn't exist | Verify the URL is correct and accessible. Check network connectivity. |
| `GIT_PUSH_FAILED` | Remote rejected push (e.g., protected branch) | Verify branch permissions on the remote. Try a different branch. |
| `MERGE_CONFLICT` | Local and remote branches have diverged with conflicting changes | Use the Conflict Resolution Dialog to choose a merge strategy. |
| `MOUNT_PATH_INVALID` | Mount path resolves outside `data/vfs/` | Use a relative path like `Documents/my-repo`. |
| `REMOTE_NOT_FOUND` | Trying to mount an unregistered remote | Run `git_add_remote` first, or add via Settings → Versions. |
| `MISSING_PARAMS` | Required tool parameters not provided | Check the tool schema for required params. |
| `git://` rejected | Used unencrypted git protocol | Convert URL to `https://` or `ssh://` format. |

### Lock Timeout Issues

- **Symptom:** Operation fails after 30s with a timeout warning in logs.
- **Cause:** Another operation on the same repo is holding the lock (possibly stuck).
- **Fix:** Check `data/logs/git-ops.log` for long-running operations. If a lock file persists, it will be auto-cleaned after 30s. Restart the server if locks are stuck in memory.

### OAuth Token Expiry

- **Symptom:** Operations fail with `GIT_AUTH_FAILURE` even though OAuth is connected.
- **Cause:** The access token has expired and refresh failed.
- **Fix:** Go to Settings → Integrations → Git Providers and reconnect. Tokens refresh automatically when within 24h of expiry, but refresh can fail if the refresh token itself has expired (GitHub tokens don't expire, GitLab tokens do).

### Merge Conflicts

- **Symptom:** `git_sync` returns `conflict_detected` or `git_merge` returns `MERGE_CONFLICT`.
- **Cause:** Both local and remote branches have changes on the same files.
- **Fix:** Use `git_merge` with the appropriate strategy, or resolve via the Conflict Resolution Dialog in Settings → Versions. The `merge-squash` strategy is recommended for most cases.
