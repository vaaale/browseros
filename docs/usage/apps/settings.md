# Settings

The **Settings** app is where you configure BOS. It's organized into **tabs**,
one per configuration area. Apps and features can add their own tabs, and every
tab is automatically available to the assistant as configuration tools — so you
can change any setting yourself *or* just ask the assistant to do it.

Select a tab from the left sidebar; the panel on the right shows its options.

---

## The tabs

| Tab | What you configure | Details |
|---|---|---|
| **Assistant** | Manage agents and pick the active personality. | [Agents & personalities](../assistant/agents-and-personalities.md) |
| **Skills** | Browse and edit the assistant's skill library. | [Skills](../self-improvement/skills.md) |
| **Apps** | Uninstall or purge installed apps. | [below](#apps) |
| **Plugins** | Assistant run-hook pipeline, and background services (start/stop/configure/logs). | [Plugins](../settings/plugins.md) |
| **Appearance** | Wallpaper, fit, and accent color. | [Appearance](../settings/appearance.md) |
| **AI Provider** | Provider, model, API key, token limits. | [AI Provider](../settings/ai-provider.md) |
| **Data Isolation** | How a previewed BOS version's data is isolated. | [Data isolation](../settings/data-isolation.md) |
| **Versions** | Preview/promote/stop BOS versions. | [Live version control](../versions/live-version-control.md) |
| **Dev Harness** | How Claude Code runs for development tasks. | [Dev Harness](../settings/dev-harness.md) |
| **Browser Automation** | Let the assistant drive a real browser. | [Browser automation](../settings/browser-automation.md) |

---

## Apps

The **Apps** tab manages apps that were installed at runtime (built‑in apps can't
be removed):

- **Uninstall** — removes the app completely. To get it back, install it again
  from the **Marketplace**.
- **Purge** — additionally **deletes the app's files**. Only offered for apps you
  authored yourself; a marketplace app's files belong to its marketplace, so
  there is nothing for BOS to delete (remove the marketplace instead).

Each of these is also available to the assistant as a tool, so you can say
"uninstall the timer app" or "purge it for good."

---

## A note on saving

Most tabs save as you edit. Secret values (like your **API key**) are **never**
shown back to you in plaintext — the field shows whether a key is set, not the key
itself.
