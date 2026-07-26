---
name: Develop in BrowserOS
description: Build an app that runs in BOS, or modify BOS itself (built-in apps, Settings, desktop, or server logic). The work is delegated to the Claude developer sub-agent.
when_to_use: When the user asks to build/create/make an app in BOS, OR to modify/change/edit/redesign/fix/extend BOS itself or any built-in part of it (e.g. a Settings tab, the Skills page, the dock, an existing app's behavior).
created_by: seed
---

Development in BOS is always done by the Claude developer sub-agent. Never write code yourself, and never use the virtual file system (file_list/file_read/file_write) to find or change code - the VFS is the user's sandboxed data, not BOS source.

First decide which use-case applies, then follow the matching reference:
- Modifying BOS itself (built-in apps, Settings pages/tabs, the desktop, API routes, or server logic - editing the BOS source under src/): read references/modifying-bos-features.md.
- Building an app that runs in BOS (a self-contained app installed into BOS and shown in a window, without changing BOS's own code): read references/building-apps.md.

Shared rules (both use-cases):
1. Do not explore the codebase or VFS yourself and do not try to understand the implementation first - delegate the whole request.
2. Before modifying BOS source, check whether the Assistant header has an Active feature branch selected. If not, ask the user to select or create one before calling the developer harness.
3. Delegate to the developer sub-agent: agent_delegate with agent 'developer' (Claude - required for all coding). For a large or vague request, optionally delegate to the planner sub-agent first and hand its plan to the developer.
4. When the developer reports back, summarize what changed and how to try it; the docs are source files under docs/usage (end users) and docs/dev (developers) and must be updated by the developer as part of the change.
5. If the developer sub-agent or Claude harness is unavailable, tell the user - never fall back to editing code through the VFS or writing it yourself.
