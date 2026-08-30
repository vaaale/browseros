# BrowserOS v2.5 Release Notes

## Overview

This release is about BrowserOS noticing things and acting on them. A new **event and notification system** gives every app and background service a way to tell you something happened. The assistant can now **show** you images and video instead of describing them. Build Studio organizes work into **Projects**, each with its own branch and workspace. Git conflicts are now handed to a **resolution agent** instead of dead-ending with "fix this yourself". Memory gained real **search**. And Workflow Manager has moved out of BrowserOS core into the Marketplace.

---

## New Features

### Events & Notifications

Apps and background services can now raise events — a new email, a finished workflow run, a health warning, a completed assistant task — and you see them in one place.

- **Bell icon in the toolbar** — shows a live unread count, no refresh needed. Click it to open the new **Event Viewer** app.
- **Open with…** — clicking an event opens whichever app handles that event type. If several can handle it, you pick one, optionally as the default for that type from then on.
- **Processing vs. read** — an event shows a spinner while background handlers are still working on it and a checkmark when they're done, updating live. That's separate from whether *you* have read it.
- **Full history** — for events no app claims, the Event Viewer shows the payload and the complete processing history: which handlers ran, what they returned, and any failures.
- **Mark all as read** in one click.

**Documentation:** [docs/usage/features/events.md](docs/usage/features/events.md)

### The assistant can show you things

A new preview window (`web_view`) lets the assistant open content on your desktop rather than describing it in text.

- **HTML, images, and video** — mockups, charts, screenshots, and clips open in an ordinary BOS window you can move and resize. Images scale to fit; video gets a normal player with seek, volume, and fullscreen.
- **From anywhere** — your files, a web address, or generated on the spot.
- **Works with plain `http://` machines on your network** — media is fetched through BrowserOS, so a clip from a render box or camera plays inside a page served over `https://` that browsers would otherwise block.
- **Playback options in plain language** — "loop it", "start it muted", "autoplay it".

**Documentation:** [docs/usage/assistant/web-view.md](docs/usage/assistant/web-view.md)

### The assistant can see images and video

Beyond showing you media, the assistant can now read it: inspect an image directly, pull keyframes out of a video to understand what happens in it, and convert documents (PDF, Office files, web pages) to markdown it can actually reason over.

### Projects in Build Studio

Specs are now organized into **Projects** rather than one flat list.

- **Group related features** — a Project holds everything for one app or area, with plain sub-folders allowed underneath for further organization. Feature numbering (`001-…`, `002-…`) restarts within each Project.
- **Activate a Project to work on it** — right-click → **Activate** creates a dedicated git branch and workspace, so in-progress work never collides with anyone else's. The tree shows each Project's active branch, or "inactive".
- **Per-Project controls** — Discard, Push feature branch, Rename/Delete, and View history with one-click Restore (history works even when the Project is inactive).

**Documentation:** [docs/usage/apps/build-studio.md](docs/usage/apps/build-studio.md)

### Git conflicts get resolved, not reported

When a merge or rebase conflicts anywhere BOS manages git — its own source, a spec store, `user-apps`, a mounted repo — the operation no longer stops with a "resolve manually" message.

- **A resolution agent takes over** — it works inside the affected repo and resolves what it can on its own.
- **A conflict pane opens in Build Studio** — you only get asked about the decisions the agent genuinely can't make.
- **Sessions survive restarts** — an interrupted resolution is picked back up rather than lost.

**Documentation:** [docs/dev/features/git-conflict-resolution.md](docs/dev/features/git-conflict-resolution.md)

### Memory that can actually be searched

- **Meaning-based search** — the assistant finds relevant memories even when your wording doesn't match theirs, combining a semantic signal with keyword matching and ranking by relevance, recency, and importance.
- **Optional and graceful** — semantic search uses an embeddings endpoint configured alongside your AI provider (Settings → AI Provider); leave the URL and key blank to reuse your main provider. If your provider has no embeddings support, search still works on keywords, recency, and importance with no error.
- **Self-tidying topics** — a memory write never fails or gets silently truncated for being too large. The topic is flagged and reorganized by a background consolidation pass instead.
- **Corrections keep history** — when you say something that contradicts an earlier memory, the old entry is marked "not current" rather than deleted. You only see the current one day-to-day.

**Documentation:** [docs/usage/memory/how-memory-works.md](docs/usage/memory/how-memory-works.md)

### Installed apps can drive the assistant

Marketplace apps run sandboxed for safety, which previously cut them off from the assistant entirely. A new **assistant capability** lets an app that asks for it start and stream an assistant run through BrowserOS itself — no security relaxation required. Apps can also query and call installed services the same way.

**Documentation:** [docs/dev/assistant/assistant-broker.md](docs/dev/assistant/assistant-broker.md)

### Google Workspace app

A built-in **GSuite** app joins the existing integration, giving Gmail, Drive, and Calendar a proper window rather than assistant-only access.

---

## Improvements

- **Faster assistant turns** — the assistant now runs independent tool calls in parallel instead of one at a time, and streams tool activity as it happens rather than after the fact.
- **Visible reasoning** — a reasoning card in the Assistant window shows what the assistant is thinking through on models that support it.
- **Long conversations hold up better** — the conversation-compaction system was redesigned, fixing several cases where very long conversations lost context or hit provider limits.
- **Services expose their own tools** — an installed service can publish tools directly to the assistant, so installing a service extends what the assistant can do without any BOS change.
- **Marketplace and app installs** — installing an item on a feature branch no longer collides with the same item installed on your main line, and a service's id is validated before anything is written.
- **Build Studio** — the file tree, resizable panes, and HTML artifact rendering all follow the branch you're actually working on; pane sizes persist across sessions.
- **Files** — upload and download files directly in the Files app.
- **Voice** — live avatar support is more tightly integrated with the assistant, and voice output is more reliable when toggling between modes.
- **Dev Harness** — improved configuration for both Claude Code and OpenCode, including model auto-complete and token-based authentication.
- **Promote and update pipeline** — the supervisor that builds and promotes BOS's own source was rebuilt into focused modules, with more reliable pull, push, worktree, and promotion handling.
- **Logging and log viewers** — clearer messages and better viewers throughout.

---

## Bug Fixes

- Fixed out-of-memory crashes in long-running deployments.
- Fixed voice mode being spoken after it was turned off, or spoken twice.
- Fixed the `.next` build cache going stale after "Update Source", which broke API routes.
- Fixed several feature-branch bugs: branch creation, branch elicitation, worktree handling, and missing branches in Build Studio.
- Fixed spec reads and writes following different branches, which could show stale content.
- Fixed OAuth token refresh, GSuite integration, and Telegram webhook handling.
- Fixed marketplace install buttons missing for non-app item types.
- Fixed the plugin loader failing under the Next.js bundler.
- Fixed a race condition when updating source in multi-user deployments.
- Fixed UI sluggishness, window resizing, blurry dialogs, and desktop icon placement.

---

## Breaking Changes

### Workflow Manager is now a Marketplace app

Workflow Manager has been removed from BrowserOS core and now ships as a Marketplace item. Its API routes and built-in tools are gone from the core product.

**What to do:** install **Workflow Manager** from the Marketplace to keep using workflows. Your existing workflow definitions are unaffected.

### Sub-agents no longer delegate further

A sub-agent can no longer spin up its own sub-agents. Delegation is one level deep, which makes runs easier to follow and stops runaway agent chains. If you had an agent relying on nested delegation, restructure it to delegate from the main assistant instead.

---

## Migration Guide

### For Users

- **Install Workflow Manager from the Marketplace** if you use workflows.
- **Turn on semantic memory search (optional)** — set an embeddings model in Settings → AI Provider. Leave the base URL and API key blank to reuse your main provider's.
- **Activate a Project before editing its specs** in Build Studio — right-click the Project → Activate. Existing specs are organized into Projects automatically.
- **Nothing else is required.** Existing installs upgrade in place.

### For Bastion Admins

- **Pull the latest image** — this release includes the out-of-memory fix and the `.next` cache fix for "Update Source".
- **Expect a rebuilt supervisor** — promote, pull, and push are handled by new modules; check the System Monitor page after upgrading to confirm containers are serving normally.

---

## Support

- **Documentation** — [docs/](docs/)
- **Issue Reports** — GitHub Issues
- **Architecture Guide** — [docs/dev/architecture-overview.md](docs/dev/architecture-overview.md)

---

# BrowserOS v2.0 Release Notes

## Overview

This release focuses on making BrowserOS easier to set up and safer to run for real: a guided first-run Setup Wizard, a rebuilt Dev Harness that lets you bring your own coding-agent backend and credentials, a video "presence" avatar for voice conversations, a reworked Marketplace, a fix for a serious production memory-leak/OOM issue, and a new secrets model for headless/service-to-service authentication.

---

## New Features

### Guided Setup Wizard

First-time setup is now a proper 6-step wizard instead of a single form.

- **Step-by-step onboarding** — AI Provider → Dev Harness → Data Isolation → Git Repos → Marketplace sources → live "Setting Up" progress screen.
- **AI Provider step** — pick your provider/model, enter an API key or base URL, with a live model list fetched from the provider.
- **Git Repos step** — pre-filled defaults for the BOS source repo, spec store, and your personal user-apps repo, all editable.
- **Marketplace step** — choose which app marketplaces to add on first boot (e.g. BOS Central, Claude Superskills, Anthropic Skills).
- **Live progress** — the final step runs the actual provisioning steps and reports success/failure for each one as it happens.

### Bring-Your-Own Coding Agent (Dev Harness)

Settings → Dev Harness has been rebuilt so you can choose and authenticate your own coding-agent backend for BOS's self-modification/Build Studio flows.

- **Claude Code or OpenCode** — pick the harness, then configure it independently of the other.
- **Multiple auth methods for Claude Code** — credential-file login (default), API key + base URL, AWS Bedrock, or Google Vertex AI.
- **New: OAuth setup-token auth** — authenticate the headless Claude Code CLI running inside BOS via `claude setup-token`, a dedicated long-lived token that won't conflict with your own local `claude` login.
- **Multiple auth methods for OpenCode** — credential-file, a named provider (Anthropic, OpenAI, OpenRouter, Groq, DeepSeek, etc.), Bedrock, Vertex, Azure, or a fully custom provider (npm package + model id).
- **Per-CLI model selection**, now with auto-complete.
- **MCP servers in the harness** — any server configured in Settings → MCP Servers can be flagged "Include in Dev Harness" to be folded automatically into the generated harness config.

**Documentation:** [docs/usage/settings/dev-harness.md](docs/usage/settings/dev-harness.md)

### Video Presence for Voice Mode

Voice conversations can now show an animated video "face" for the assistant, not just play audio.

- **Video toggle** — a new button next to the mic opens a small window showing the assistant's face while it talks (only shown if you have an avatar plugin installed).
- **Audio/video linked correctly** — turning off the speaker turns off the face too; closing the face window reverts to audio-only.
- **Plugin-based** — the underlying surface is provided by a BOS plugin (e.g. a "Live Avatar" plugin), so third parties can supply their own avatar engine.
- **More reliable voice output** — voice output is now a single three-state setting (off / audio / avatar) instead of two overlapping toggles, fixing bugs where replies could be spoken after voice was turned off, or spoken twice.

**Documentation:** [docs/dev/features/voice-mode.md](docs/dev/features/voice-mode.md), [docs/usage/assistant/using-the-assistant.md](docs/usage/assistant/using-the-assistant.md)

### Marketplace: Sources Sidebar

The Marketplace app has a new master-detail layout.

- **Sources sidebar** — an "All" entry plus one entry per marketplace (including "My Apps", your own private marketplace), each showing a live item count and a warning icon if its manifest fails to parse.
- **Filter by source or search** — click a source to filter the catalogue, or use the search box across all sources; both can be combined.
- **Fixed missing install buttons** — items that are plugins rather than apps (e.g. a voice engine like "Live Avatar") previously had no install/uninstall control at all; every installable item type (app, service, voice engine, integration, server plugin) is now recognized correctly.

**Documentation:** [docs/dev/apps/marketplace-app.md](docs/dev/apps/marketplace-app.md), [docs/usage/tutorials/marketplace.md](docs/usage/tutorials/marketplace.md)

### Build Studio: Rendered Web Views + Conversation Reviewer

- **HTML rendering** — Build Studio's viewer now renders HTML artifacts (e.g. UI mockups) live in a sandboxed frame instead of showing raw markup as text.
- **Branch-aware previews** — the rendered web view now correctly follows whichever feature branch you're currently working on.
- **New Conversation Reviewer agent** — a read-only sub-agent you can invoke to audit a past BOS conversation for problems (wrong tool calls, ignored instructions, false success claims, misdirected delegation) and produce a written report with concrete fixes. It never applies changes itself.

**Documentation:** [docs/dev/build-studio.md](docs/dev/build-studio.md)

### Google Workspace CLI for the Assistant

The assistant's run-command tool can now invoke a Google Workspace CLI (`gws`) directly, giving it a scriptable way to work with Gmail, Drive, and Calendar from a terminal-style command in addition to the existing browser-based GSuite OAuth integration.

**Documentation:** [docs/usage/integrations/gsuite.md](docs/usage/integrations/gsuite.md), [docs/dev/run-command/run-command.md](docs/dev/run-command/run-command.md)

### Headless & Service-to-Service Authentication

A new secrets model lets non-browser clients (filesystem-mount clients, sync agents, marketplace service workers) authenticate through Bastion's reverse proxy using per-service credentials, without requiring a Bastion code change for every new service.

**Documentation:** [docs/dev/features/headless-client-auth.md](docs/dev/features/headless-client-auth.md)

---

## Improvements

### Deployment & Bastion (Multi-User Docker)

- **Fixed a serious out-of-memory issue** — user containers were unintentionally serving BOS in `next dev` (development) mode instead of production mode, causing unbounded memory growth over time. Containers now build and serve via `next start`.
- **New: Pull without discarding local changes** — re-provisioning now offers `pull-and-update-src` (fetch + merge, keeps your local commits) alongside the existing `update-src` (fetch + hard reset). Both now clear the stale `.next` build cache automatically.
- **New System Monitor page** — surfaces whether BOS is actually serving requests (not just "container Up"), restart counts, and OOM-kill detection.
- **No more idle auto-stop** — containers no longer stop themselves after an idle timeout.
- **Fixed a shallow-clone bug** — source updates/pushes could silently fail after a platform redeploy (e.g. Dokploy re-cloning); this is now detected and auto-repaired at startup and on push.
- **Fixed WebSocket proxying for voice** — the supervisor was reading service config from the wrong path, silently dropping `wss://` voice connections with no visible error.

**Documentation:** [docs/dev/deployment.md](docs/dev/deployment.md), [docs/dev/self-modification/live-version-control.md](docs/dev/self-modification/live-version-control.md)

### Assistant

- **Improved context compaction** — reduced cases where important context was dropped too aggressively during long conversations.
- **Faster chat input** — fixed UI sluggishness while typing in the assistant chat box.
- **Streaming tool calls** — tool call output now streams incrementally instead of appearing all at once.

### Build Studio & Agents

- **Strengthened architect agents** — improved reliability of the "architect" agents used for planning and reviewing specs.
- **Updated Build Studio agent and skills** — refined seeded agent/skill definitions for spec authoring, and fixed tools that referenced non-existent capabilities.

---

## Bug Fixes

- Fixed GSuite OAuth redirect URL and client-secret upload handling.
- Fixed Telegram webhook URL construction.
- Fixed the "top tools" list in Settings → Versions.
- Fixed linking of `user-data` in the supervisor.
- Fixed a stale marketplace/user-apps path mismatch after aligning `user-apps/` with the marketplace layout.
- Fixed the `install_app` tool and updated related agent/skill definitions.

---

## Breaking Changes

None. Existing BOS installs upgrade in place; the Setup Wizard only runs for new installs.

---

## Migration Guide

### For Users

- **Re-run onboarding not required** — existing installs keep their current configuration; the new Setup Wizard only appears for fresh installs.
- **Dev Harness** — if you previously relied on interactive credential-file login for Claude Code, consider switching to the new OAuth setup-token option in Settings → Dev Harness to avoid conflicts with your local `claude` CLI session.
- **Voice + Video** — install an avatar plugin (e.g. "Live Avatar") from the Marketplace to enable the new video presence window in voice mode.

### For Bastion Admins

- **Update your deployment** — pull the latest `bastion/` image; containers will now serve in production mode (`next start`), resolving the OOM issue present in earlier builds.
- **Use `pull-and-update-src`** when you want to update a user's BOS source while preserving their local commits; use `update-src` only when you intentionally want to discard local changes.
- **Check the new System Monitor page** after upgrading to confirm containers are serving correctly.

---

## Support

- **Documentation** — [docs/](docs/)
- **Issue Reports** — GitHub Issues
- **Architecture Guide** — [docs/dev/architecture-overview.md](docs/dev/architecture-overview.md)

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
