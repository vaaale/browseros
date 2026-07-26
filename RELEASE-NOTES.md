# BrowserOS v1.7 Release Notes

## Overview

This release introduces major new capabilities for extensibility and repository integration, significant enhancements to the Files app, and a completely rearchitected plugin and service system.

---

## New Features

### Service Daemons

Services are now first-class citizens in BrowserOS. Install and manage long-running background worker threads (WebSocket servers, pollers, daemons) directly from the Marketplace or develop your own.

- **Install from Marketplace** — Services are installable just like apps, with the same version control and rollback semantics.
- **Settings UI** — New Settings → Plugins → Services panel shows all installed services with live status, start/stop/restart controls, configuration panels, and log viewers.
- **Bundled UI optional** — Services can include an optional app for interaction, but the service itself runs in the background.
- **Worker thread isolation** — Services run as Node.js worker threads with configurable memory limits, crash recovery with exponential backoff, and graceful shutdown.
- **Configuration** — User-editable config files with JSON Schema validation; runtime state (actual port/host binding) kept separate.
- **Dependency management** — Services can declare dependencies on other services; the system respects startup order.

**Documentation:** [docs/dev/apps/services.md](docs/dev/apps/services.md)

### Plugin Pipeline for the Assistant

Extend the assistant's behavior without modifying BOS source code. Plugins can hook into the LLM call flow, intercept tool calls, and customize the system prompt.

- **Extensible hooks** — Plugins can implement any subset of: `beforeRun`, `extendSystemPrompt`, `beforeToolCall`, `afterToolCall`, `afterRun`, `onRunFinished`, `onError`.
- **Built-in plugins** — Two example plugins ship with BOS:
  - **bos-compaction** — Compresses old conversation turns to reduce context size.
  - **bos-memory** — Manages persistent user/project/feedback memories.
- **Configuration in Settings** — Plugins appear in Settings → Plugins with config panels driven by JSON Schema.
- **Safe execution** — Every hook is guarded with a 15-second timeout and try/catch; a slow or crashing plugin never blocks the assistant.

**Documentation:** [docs/dev/plugins/plugin-pipeline.md](docs/dev/plugins/plugin-pipeline.md)

### External Git Repository Integration

Register external git repositories, manage multiple remotes, and authenticate via OAuth (GitHub/GitLab), personal access tokens, or SSH keys.

- **Register external remotes** — Point BOS at GitHub, GitLab, or any git-over-HTTPS/SSH server from Settings → Versions.
- **OAuth authentication** — Connect your GitHub or GitLab account; tokens are stored in BOS's encrypted secrets store and automatically refreshed.
- **Multi-remote push** — Push the current branch to multiple registered remotes simultaneously with a single command.
- **Mount remote branches** — Clone any branch from a registered remote into the VFS so its files appear alongside your local content.
- **Conflict resolution** — Detect ahead/behind state, merge, squash-merge, or stash-commit to resolve diverged branches.
- **Auto-push** — Enable auto-push per remote to automatically push commits to one or more remotes.
- **Comprehensive logging** — All git operations are logged to JSONL with sensitive data redacted.

**Documentation:** [docs/git-external-repos.md](docs/git-external-repos.md)

**Agent Tools:**
- `git-mounts` — List, create, delete, and sync mounted remote branches.
- `git-remotes` — Register/unregister external remotes, configure OAuth.
- `git-push` — Push to selected remotes.

### Files App: Upload and Download

Improved file management in the VFS with support for bulk uploads and folder downloads.

- **Drag-and-drop upload** — Drag files from your desktop or another app and drop them into any folder; upload progress shown in a banner.
- **Download single files** — Right-click any file and select Download to save it to your computer.
- **Download folders as ZIP** — Right-click any folder and select Download as ZIP to bundle the entire contents (including subfolders) into a `.zip` archive.
- **Fixed `/Specs` directory display** — The Specs folder now properly appears in the Files app.

**Documentation:** [docs/usage/apps/files.md](docs/usage/apps/files.md)

### Voice Mode Support

BrowserOS now integrates with voice services for audio input/output in the chat interface (Docker deployment with voice services enabled).

- **Docker Compose Integration** — Voice services are included in the Docker Compose stack when enabled.
- **Seamless Chat Integration** — Use your voice to interact with the assistant and hear responses read aloud.

### Workflows App Migration

The Workflows app has been fully migrated to the new architecture, improving compatibility and maintainability.

---

## Improvements

### Settings UI Enhancements

- **Plugins Tab** — Unified panel for both plugins and services with live status updates via NDJSON event streams.
- **Dev Harness Improvements** — Auto-complete model selection dropdown and improved logging viewers.
- **Account Management** — Enhanced bastion UI for multi-user deployments with better account and lifecycle management.

### Git Operations

- **Improved terminal support** — Better WebSocket proxying for services with their own network ports in Docker deployments.
- **GitFS enhancements** — Improved handling of git repository origins and syncing.
- **Bastion improvements** — Fixed Docker provisioning, resolved memory leaks, improved log redirection.

### Developer Experience

- **Enhanced documentation** — New design heuristics guide, extended apps/services/plugins documentation with examples and troubleshooting.
- **Better error messages** — More actionable error handling throughout the assistant and UI.
- **Skill additions** — New `skill_patch` tool for fine-grained skill modifications.

### Docker Deployment (Multi-User)

- **Supervisor enhancements** — Better service port proxying, improved artifact rendering, fixed Dokploy compatibility.
- **Improved provisioning** — Cleaner `.next` cache management, resolved timeout issues during updates.
- **Memory management** — Fixed memory leaks in long-running bastion processes.

---

## Bug Fixes

- Fixed empty `/Specs` directory appearing in Files app.
- Fixed Terminal Service WebSocket proxying in supervised environments.
- Fixed blurry dialogs in the UI.
- Fixed git promote/branch elicitation workflow issues.
- Resolved compaction and memory loop issues that could cause boot failures.
- Fixed race conditions in bastion update source operations.
- Fixed missing git repository initialization for user-apps and other critical directories.

---

## Architecture & Documentation

New documentation added:

- **[Design Heuristics](docs/dev/design-heuristics.md)** — Architectural principles for extending BOS safely.
- **[Plugin Pipeline](docs/dev/plugins/plugin-pipeline.md)** — Complete guide to writing plugins.
- **[Service Daemons](docs/dev/apps/services.md)** — Comprehensive guide to building services.
- **[External Git Repository Integration](docs/git-external-repos.md)** — Setting up and using multiple git remotes.
- **[Extended API Reference](docs/dev/api-reference.md)** — Updated endpoint documentation.
- **[Repository & Data Layout](docs/dev/repository-and-data-layout.md)** — Clarified data organization.

---

## Breaking Changes

None. This release is fully backward compatible with v1.6.

---

## Migration Guide

### For Users

- **New Services & Plugins** — The Marketplace now includes services in addition to apps. Installed services appear in Settings → Plugins.
- **Voice Mode** — If deploying with Docker, voice services are available (see `docker-compose.yml` for configuration).
- **OAuth for Git Repositories** — You can now authenticate with GitHub/GitLab accounts from Settings → Versions instead of relying on SSH keys alone.

### For Developers

- **Building Services** — See [Service Daemons documentation](docs/dev/apps/services.md) for the complete guide. Services are structured like apps but run as worker threads.
- **Building Plugins** — See [Plugin Pipeline documentation](docs/dev/plugins/plugin-pipeline.md). Plugins hook into the assistant's run loop.
- **Extending Git Operations** — See [External Git Repository Integration guide](docs/git-external-repos.md) for adding remote support to custom agents.

---

## Known Limitations

- **Services in `npm run dev`** — Worker thread creation under Turbopack bundler requires a workaround; always test services with a real `npm run dev` environment, not just unit tests.
- **Port auto-retry** — A service configured to a port already in use fails hard; the user must change the port in Settings.
- **Container services** — Services run as worker threads only; Docker/container-based services are not supported in v1.7.
- **Direct function exports** — Services communicate only via the `postMessage` IPC protocol; direct function exports are not available.
- **`hooks/` directory** — Service hooks are inert; the hookable system exists but isn't wired yet (spec FR-034–FR-037).

---

## Testing

Comprehensive test coverage has been added:

- **E2E tests** — External repository integration, file upload/download, OAuth flows.
- **Unit tests** — Services, git operations, OAuth providers, sync status, mounts.
- **Benchmarks** — Git performance under various workloads.

Run tests with:

```bash
# Unit tests
npx playwright test -c playwright.unit.config.ts tests/services/
npx playwright test tests/gitops/

# E2E tests
npx playwright test e2e/
```

---

## Thank You

This release includes contributions and improvements across the entire BrowserOS platform. Thanks to everyone who reported issues, tested features, and provided feedback.

---

## Installation & Upgrade

To upgrade from v1.6:

```bash
git pull origin main
npm install
npm run dev
```

Docker users:

```bash
docker pull browseros:latest
docker-compose up -d
```

For detailed upgrade instructions, see [docs/dev/deployment.md](docs/dev/deployment.md).

---

## Support

- **Documentation** — [docs/](docs/)
- **Issue Reports** — GitHub Issues
- **Architecture Guide** — [docs/dev/architecture-overview.md](docs/dev/architecture-overview.md)
