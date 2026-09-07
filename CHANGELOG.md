# Changelog

## 2026-09-07

### Highlights

- **A scheduled job can no longer run twice.** BOS runs several server processes over one data root (base, preview, dev) — the scheduler could dispatch the same due job once per process. A container-wide lock now elects one daemon owner and locks every dispatch, so a job runs exactly once no matter how many processes are alive.
- **Tools are organized into groups you can rename and retune.** Settings → Tools now shows every tool grouped (Web, Files, Gmail, Scheduler, and so on), with an editable description and search aliases per group — the same text the assistant's own tool search and system-prompt index use to decide what's worth looking into.
- **Apps can declare which file types they open.** Double-click a file, or right-click → "Open with…", and the right app launches with the file — built-in or installed, render or edit.
- **Promoting a feature branch no longer times out behind a reverse proxy.** Promote now runs as a background job you poll for completion instead of one long blocking request.
- **Tool search got sharper and simpler.** The three different `find_tools` implementations are down to one, with real relevance ranking instead of a grab-bag of heuristics.

### Added

- **Tool groups** — every assistant tool belongs to a group; expand one in Settings → Tools to rewrite its description or add your own search aliases, with **Reset** to restore the built-in text. A group with unresolved tools (a marketplace item's manifest pointing at a group id that doesn't exist) is surfaced as a visible warning instead of being filed away silently.
- **File type handlers** — apps declare `fileHandlers` in their manifest (built-in or installed) and the Files app launches the right one on double-click or "Open with…", with a per-type "always open with" selection that falls back cleanly if the app is later uninstalled.
- A new **path-shaped raw file route** (`/api/fs/raw/<path>`) so a previewed HTML document's relative links and scripts resolve against its own folder instead of 404ing.
- The chat's **active feature branch** can now be set or cleared through the API directly, serialized against the assistant's own message saves so the two can't race.
- **OpenCode's context window** now follows whatever you set in Settings → Dev Harness instead of silently falling back to OpenCode's own built-in default for the model.

### Changed

- **Scheduler dispatch is now locked at two layers**: one elected daemon owns ticking, and every individual job dispatch takes its own disk lock for the run's duration — closing a bug where a non-idempotent scheduled job (e.g. a daily review) could fire several times concurrently and blow through context limits.
- **`find_tools` is one implementation now**, ranking matches by a real per-term relevance score across a tool's id, description, aliases, and group — two duplicate, now-dead implementations were removed.
- **Promote is asynchronous** — it returns a job id immediately and the UI polls until the merge actually finishes, and it now requires you to be actively previewing the candidate first rather than just seeing a passed health check.
- The supervisor's promote/push/worktree pipeline picked up a large expansion of test coverage aimed at the concurrency and credential-handling edge cases that have historically caused production incidents.

### Removed

- The old standalone discovery API route and the per-subagent `tools.ts` allowlist file — both fully superseded by tool groups and the capability registry.

### Fixed

- Rebuilding an already-installed app from the assistant (`app_build`) could silently create a second, disconnected item instead of updating the original.
- A scheduled job dispatching multiple times across live server processes (see Highlights).
- Promote requests being cut off mid-merge by a reverse proxy's request timeout on larger builds.

## 2026-08-30

### Highlights

- **BrowserOS can now tell you when something happens.** A bell in the toolbar shows a live unread count, and a new Event Viewer collects everything apps and background services raise — a finished run, a new message, a health warning. Click an event and the app that handles it opens.
- **The assistant can show you things, and see them.** It can open images, video, and HTML in a preview window on your desktop instead of describing them — and it can read them too, inspecting an image or pulling keyframes out of a video to understand what's in it.
- **Specs are organized into Projects.** Group related features under one Project, activate it to get its own branch and workspace, and work without colliding with anything else in progress.
- **Git conflicts get resolved instead of reported.** When a merge or rebase conflicts anywhere BOS manages git, a resolution agent takes over and only asks you about decisions it genuinely can't make.
- **Memory can be searched by meaning.** Ask a question in your own words and the assistant finds the relevant memory even when the wording doesn't match. Contradictions mark the old entry as no longer current rather than deleting it.

### Added

- An **Event Viewer** app and a toolbar bell with a live unread count, including "open with…" routing so the right app handles each event type.
- A **preview window** the assistant opens to show HTML, images, and video — from your files, a web address, or generated on the spot, with playback options in plain language.
- The ability for the assistant to **read images and video** directly, and to convert PDFs, Office documents, and web pages to text it can reason over.
- **Projects** in Build Studio, with per-Project activation, branch and workspace, push, discard, and file history with one-click restore.
- An **agent-driven git conflict resolution** flow with a conflict pane in Build Studio, and sessions that survive a restart.
- **Semantic memory search** alongside keyword search, with automatic fallback when your provider has no embeddings support.
- Automatic **memory consolidation** — oversized topics are reorganized in the background instead of rejecting or truncating writes.
- A built-in **Google Workspace app** for Gmail, Drive, and Calendar.
- The ability for installed Marketplace apps to **drive the assistant** and call installed services, without weakening their sandbox.
- **Upload and download** in the Files app.
- A **reasoning card** in the Assistant window on models that support it.

### Changed

- The assistant now runs **independent tool calls in parallel** and streams tool activity live, so turns finish noticeably faster.
- **Conversation compaction was redesigned**, fixing cases where very long conversations lost context or hit provider limits.
- **Installed services can publish their own tools** to the assistant, so installing a service extends what the assistant can do.
- Installing an item **on a feature branch** no longer conflicts with the same item installed on your main line.
- The **promote / pull / push pipeline** was rebuilt into focused modules for more reliable source updates and promotions.
- Build Studio's tree, panes, and HTML rendering now consistently follow the branch you're working on, and pane sizes persist across sessions.

### Removed

- **Workflow Manager is no longer part of BrowserOS core** — it ships as a Marketplace app. Install it from the Marketplace to keep using workflows; existing workflow definitions are unaffected.
- **Sub-agents can no longer delegate to further sub-agents.** Delegation is one level deep, which keeps runs followable and prevents runaway agent chains.

### Fixed

- Out-of-memory crashes in long-running deployments.
- Voice replies being spoken after voice was turned off, or spoken twice.
- A stale build cache after "Update Source" that broke API routes.
- Several feature-branch bugs: branch creation, elicitation, worktree handling, and branches missing from Build Studio.
- Spec reads and writes following different branches, which could show stale content.
- OAuth token refresh, Google Workspace integration, and Telegram webhook handling.
- Missing install buttons in the Marketplace for items that aren't apps.
- A plugin loader failure under the Next.js bundler.
- A race condition when updating source in multi-user deployments.
- UI sluggishness, window resizing, blurry dialogs, and desktop icon placement.

## 2026-07-11

### Highlights

- **Conversations now run on the server, not the browser.** Assistant conversations keep running even if you close the tab, reload, or switch devices — reopening a conversation reconnects to whatever the assistant was already doing instead of losing progress. Stopping a run now reliably stops it, from any tab.
- **Live UI mockups during app design.** When you ask the assistant to design an app with a UI, it can now sketch and iterate on the actual interface live in a new "UI Preview" window, styled to match BrowserOS's dark theme, instead of describing the UI in text.
- **A new guided path for building features end-to-end.** Say "I want to build X" and the assistant can now walk you through the whole lifecycle — requirements, UI design, spec, branch, plan, implementation, tests, and promoting or discarding the result — instead of you having to drive each step yourself.
- **Tools are more resilient.** Slow or hung tool calls now time out (configurable in Settings) and are reported back to the assistant instead of silently hanging the conversation. Conversation history can no longer be corrupted by two things saving at once.
- **Memory is now per-agent.** Each assistant agent keeps its own memory instead of sharing one pool, so different agents don't bleed context into each other.

### Added

- A guided **feature-wizard** flow for building a new BOS feature from scratch, start to finish.
- A **UI Preview** app the assistant can open to render and iterate on live UI mockups while designing an app with you.
- A new **app-design skill** that interviews you about what you want, categorizes the request, and designs the UI live before handing off implementation.
- **Configurable tool timeouts** in Settings, so you can control how long the assistant waits on a slow tool before giving up and reporting the failure.
- A **self-improvement indicator** so you can see when the assistant is reflecting on and refining its own behavior after a task.
- Automatic conversation titling, generated once a conversation actually finishes rather than guessed early.
- **Multimodal attachments** — the assistant can now receive images/files as part of a message through the new conversation engine.
- A **unified activity log** in the toolbar showing recent frontend, backend, and system activity in one place, color-coded by severity, with an "errors only" filter.
- Expanded **Build Studio** guidance covering every stage of writing a spec (clarify, plan, tasks, analysis, implementation, convergence).
- New developer-facing guides on building apps and features within BrowserOS.

### Changed

- **Which tools an assistant agent can see is now controlled entirely from Settings**, per agent — there's no more hidden, built-in list of tools that are hidden by default regardless of what you configure. If you had an agent relying on tools being hidden automatically, you'll need to hide them explicitly now.
- **Settings' tool listing is easier to read** — tool names no longer get cut off, and descriptions are shown in a larger, more legible size.
- **Reopening a spec you already had open now shows the latest edits.** Previously, reopening the same document (or hitting refresh) could keep showing stale content until you navigated away and back.
- **Highlighting a section of a spec is more reliable and complete** — it now scrolls to and highlights the entire section (not just the heading), and stays highlighted until you click it away, instead of fading on a timer or silently failing.
- **The Memory app** has been updated throughout to reflect memory now being organized per agent.
- The main Assistant window now runs on the new, more reliable conversation engine.

### Removed

- The **old chat engine** and all of its tool-registration wiring have been fully retired in favor of the new server-run engine.
- The **old shared memory file** has been replaced by the new per-agent memory system.

### Fixed

- Conversations with a lot of tool activity no longer get truncated when reloaded, and auto-titling works for them again.
- Tool call arguments were sometimes getting silently dropped when passed through MCP integrations — fixed, so tools now receive the arguments the assistant intended.
- Fixed a bug where a newly opened window's tools (e.g. right after opening UI Preview) weren't usable until the assistant's *next* conversation turn — they're now available immediately.
- Removed some leftover error noise in the browser console when closing a conversation.
