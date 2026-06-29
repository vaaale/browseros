# Settings overview

**Settings** is organized into tabs, one per configuration area. Pick a tab on the
left; its options appear on the right.

Two things make BOS Settings special:

1. **Apps and features add their own tabs.** Settings isn't a fixed list — each
   feature registers a configuration "namespace" that becomes a tab.
2. **Every setting is also an assistant tool.** Anything you can change here, you
   can also just *ask the assistant to change*. Registering a tab automatically
   exposes its fields to the assistant.

---

## The tabs

| Tab | Purpose |
|---|---|
| **[Assistant](../assistant/agents-and-personalities.md)** | Manage agents and the active personality. |
| **[Skills](../self-improvement/skills.md)** | Browse and edit the skill library. |
| **[Apps](../apps/settings.md#apps)** | Uninstall / restore / purge installed apps. |
| **[Appearance](appearance.md)** | Wallpaper, fit, accent color. |
| **[AI Provider](ai-provider.md)** | Provider, model, API key, token limits. |
| **[Data Isolation](data-isolation.md)** | How previewed versions isolate data. |
| **[Versions](../versions/live-version-control.md)** | Preview / promote / stop BOS versions. |
| **[Dev Harness](dev-harness.md)** | How Claude Code runs for development. |
| **[Browser Automation](browser-automation.md)** | Let the assistant drive a real browser. |

---

## Secrets

Secret fields (like the **API key**) are **never** returned to the screen in
plaintext. The field only indicates whether a value is set — so your key can't be
read back out of BOS.
