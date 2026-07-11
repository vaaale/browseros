# BrowserOS documentation

BrowserOS documentation is split into two trees by audience. Both are kept in sync
with the codebase (the **code is the source of truth**; intentional divergence from
the specs in `specs/` is tracked in [`specs/discrepancies.md`](../specs/discrepancies.md)).

---

## 📘 [`docs/usage/`](usage/introduction.md) — for users

How to *use* BOS: the desktop, the built‑in apps, the Assistant, memory, skills,
building/modifying things, Settings, and live version control.

Start at **[Introduction](usage/introduction.md)**.

- **Desktop:** [windows & dock](usage/desktop/desktop-windows-and-dock.md)
- **Apps:** [Files](usage/apps/files.md) · [Browser](usage/apps/browser.md) · [Assistant](usage/apps/assistant.md) · [Memory](usage/apps/memory.md) · [Docs](usage/apps/docs.md) · [Settings](usage/apps/settings.md) · [Workflow Manager](usage/apps/workflow-manager.md)
- **Assistant:** [using it](usage/assistant/using-the-assistant.md) · [agents & personalities](usage/assistant/agents-and-personalities.md) · [delegation & sub‑agents](usage/assistant/delegation-and-sub-agents.md)
- **Memory:** [how memory works](usage/memory/how-memory-works.md)
- **Self‑improvement:** [learning from experience](usage/self-improvement/learning-from-experience.md) · [skills](usage/self-improvement/skills.md)
- **Building & modifying:** [building apps](usage/building-and-modifying/building-apps.md) · [modifying BOS](usage/building-and-modifying/modifying-bos.md)
- **Settings:** [overview](usage/settings/overview.md) · [AI provider](usage/settings/ai-provider.md) · [dev harness](usage/settings/dev-harness.md) · [appearance](usage/settings/appearance.md) · [browser automation](usage/settings/browser-automation.md) · [data isolation](usage/settings/data-isolation.md)
- **Versions:** [live version control](usage/versions/live-version-control.md)
- **MCP:** [MCP servers](usage/mcp/mcp-servers.md)
- **Integrations:** [GSuite (Gmail / Drive / Calendar / Contacts)](usage/integrations/gsuite.md)

> The in‑OS **Docs app** renders these trees (`docs/usage` + `docs/dev`) as a
> **read‑only** reader, so users can read this documentation inside BOS.

---

## 🛠️ [`docs/dev/`](dev/architecture-overview.md) — for the developer agent

How BOS is *built* — for Claude Code and human contributors extending or modifying
BOS. Mirrors the usage structure with implementation detail, file paths, and recipes.

Start at **[Architecture overview](dev/architecture-overview.md)**.

- [Repository & data layout](dev/repository-and-data-layout.md)
- **OS shell:** [window manager & store](dev/os-shell/window-manager-and-store.md) · [VFS](dev/os-shell/virtual-file-system.md) · [settings & wallpaper](dev/os-shell/settings-and-wallpaper.md)
- [Configuration system](dev/configuration/configuration-system.md)
- **Apps:** [Apps guide](dev/guides/apps.md) · [built‑in](dev/apps/built-in-apps.md) · [installed (GitFS)](dev/apps/installed-apps.md)
- **Features & components:** [Features & components guide](dev/guides/features-and-components.md)
- **Assistant:** [overview](dev/assistant/overview.md) · [actions & tools](dev/assistant/actions-and-tools.md) · [sub‑agents & delegation](dev/assistant/sub-agents-and-delegation.md) · [API](dev/assistant/api/assistant-api.md)
- [Memory](dev/memory/memory.md) · [Self‑improvement](dev/self-improvement/self-improvement.md)
- [MCP](dev/mcp/mcp.md) · [Browser automation](dev/automation/browser-automation.md) · [Web proxy](dev/web-proxy/web-proxy.md)
- **Self‑modification:** [live version control](dev/self-modification/live-version-control.md) · [DataFS](dev/self-modification/data-isolation-datafs.md) · [testing](dev/self-modification/testing.md)
- [Workflows](dev/workflows/workflows.md)
- [API reference](dev/api-reference.md) · [Extending BOS](dev/extending-bos.md) · [Design heuristics & gotchas](dev/design-heuristics.md)

---

## Keeping docs in sync

When you add, change, or remove an app or feature:

1. Update the relevant page(s) under `docs/usage/` and `docs/dev/` — the in‑OS
   Docs app renders these automatically (there's no separate runtime copy).
2. If the architecture changed, update `specs/` (and note any code↔spec divergence in
   `specs/discrepancies.md`).
