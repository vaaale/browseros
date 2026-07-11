# Changelog

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
