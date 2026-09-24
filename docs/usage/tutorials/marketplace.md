# Tutorial: Using the Marketplace

The **Marketplace** app lets you extend BOS with apps, skills, and spec templates published in external git repositories. Once a marketplace is registered, its contents appear in a browsable catalogue — you can search, preview, and install individual items with a single click.

This tutorial walks through adding two real marketplaces, filtering the catalogue, and installing an app and a skill.

---

## What is a Marketplace?

A marketplace is a git repository that follows one of three recognised formats:

| Format | Used by | What it ships |
|---|---|---|
| **BOS native** (`marketplace.json` at root) | `vaaale/bos-marketplace` | Apps, specs |
| **Claude skills** (`skills_index.json` at root) | `ericgandrade/claude-superskills` | Skills |
| **Claude Code plugin marketplace** (`.claude-plugin/marketplace.json`) | `anthropics/skills`, `obra/superpowers` | Skills |

BOS detects the format automatically when you add the URL — no manual configuration needed.

In the Claude Code plugin format, a plugin may list its skills explicitly
(`plugins[].skills[]`) or omit the list entirely — the standard convention, used
by most published plugins — in which case BOS discovers every
`<source>/skills/<name>/SKILL.md` under the plugin's source directory
automatically.

---

## 1. Open the Marketplace app

Click the **Marketplace** icon in the dock (the grid/shop icon), or ask the assistant:

> *"Open the Marketplace app."*

The app opens empty, ready to accept its first marketplace URL.

![Marketplace app — empty state](../../assets/marketplace/01-marketplace-open.png)

The window has two panes. On the left is a **Sources** sidebar listing everywhere
your content can come from: an **All** entry, **My Apps** (your own private
marketplace — anything you or the assistant builds lands there), and one entry per
marketplace you add, each with the number of items it currently offers. On the
right is the catalogue itself, grouped into one section per source.

---

## 2. Add the BOS Marketplace

The BOS Marketplace ships ready-to-install apps and adoptable spec templates maintained by the BOS team.

Paste the following URL into the **"Add marketplace by git URL"** field at the top:

```
https://github.com/vaaale/bos-marketplace.git
```

![Entering the BOS Marketplace URL](../../assets/marketplace/02-add-bos-marketplace-url.png)

Press **Enter** or click **Add**. BOS clones the repository and reads its manifest — this takes a few seconds. Once done, the marketplace section expands with all of its items:

![BOS Marketplace added — items visible](../../assets/marketplace/03-bos-marketplace-added.png)

Each item shows one or more type badges:
- `spec` — an adoptable spec template (opens in Build Studio)
- `app` — a pre-built sandboxed app
- `skill` — an assistant skill

---

## 3. Add the Anthropic Skills Marketplace

The Anthropic agent-skills repository publishes a curated set of skills for document processing, design, and more.

Paste this URL and press **Enter** or click **Add**:

```
https://github.com/anthropics/skills.git
```

![Entering the Anthropic Skills URL](../../assets/marketplace/04-add-anthropic-url.png)

After the clone completes, BOS detects the Anthropic format automatically and converts it into a browsable catalogue. Both marketplaces are now listed:

![Both marketplaces registered](../../assets/marketplace/05-anthropic-added.png)

Items already installed in your BOS instance are highlighted with a green **✓ installed** badge and a tinted card border, so you can see at a glance what you already have.

---

## 4. Narrow things down

There are two ways to cut down what you're looking at, and they work together.

**Pick a source.** Click any entry in the left sidebar to show only that source's
items — handy once you've added a skill collection with dozens of them. Click
**All** to go back to everything. The number beside each entry tells you how many
items it currently has, so you can see where something is before you click.

**Collapse what you're not using.** Click a section's header in the right pane to
fold its items away; click again to unfold. The header stays put, so its **Sync**
and **Remove** buttons are always within reach. Sections start expanded, and
picking a source in the sidebar always expands it.

**Filter by text.** The **Filter items…** field narrows the list in real time. It matches against item names, descriptions, and tags.

For example, type `timer` to instantly find Pomodoro:

![Search filter showing only the Pomodoro app](../../assets/marketplace/06-search-filter.png)

The filter hides entire sections when none of their items match, and the sidebar counts follow it — clear the field to return to the full catalogue. Text filtering and source selection combine, so you can search within one source.

Some useful searches to try:

| Query | Finds |
|---|---|
| `timer` | Pomodoro focus timer |
| `pdf` | PDF document skill |
| `design` | Design-related skills and apps |
| `spec` | Items that ship a spec template |

---

## 5. Install a skill

Skills extend the assistant — once installed, the assistant can invoke them automatically when the situation matches.

Scroll to any **skill** item (green `skill` badge) and click **Install skill**:

![About to install a skill](../../assets/marketplace/07-before-install-skill.png)

BOS reads the entire skill folder from the marketplace clone — the `SKILL.md` instruction file, any `scripts/`, and all `references/` — and saves everything into the local skill store. A confirmation notice appears at the top and the item card gains a **✓ installed** badge:

![Skill installed — badge visible](../../assets/marketplace/08-skill-installed.png)

The skill is available to the assistant immediately; no restart needed.

> **Tip:** To see your installed skills, open **Settings → Skills**.

---

## 6. Install an app

Apps from the marketplace run in an isolated sandbox so they can't access BOS internals directly. Each app communicates with BOS only through the capability broker.

Scroll to any **app** item (blue `app` badge) and click **Install app**:

![About to install an app](../../assets/marketplace/09-before-install-app.png)

BOS copies the pre-built app files into your local app store. A notice confirms the install and the app appears on your desktop immediately — no browser refresh needed:

![App installed — confirmation notice](../../assets/marketplace/10-app-installed.png)

Click the new icon on your desktop to launch it.

---

## 7. Keep marketplaces up to date

Marketplace repositories are updated independently by their authors. To pull the latest items:

1. Find the marketplace section header.
2. Click **Sync**.

BOS runs `git pull` on the cloned repo and refreshes the catalogue. Any newly published items appear instantly; the **✓ installed** badges on items you've already installed are preserved.

---

## 8. Remove a marketplace

Click **Remove** on any marketplace header to unregister it. BOS deletes the local clone and hides its items from the catalogue.

> **Note:** Removing a marketplace does not uninstall apps or skills you have already installed from it — those remain in your local store.

---

## Summary

| Task | How |
|---|---|
| Add a marketplace | Paste the git URL into the top field, press Enter |
| Browse items | Scroll, or use the filter field to search by name / tag |
| Install a skill | Click **Install skill** on any `skill` item |
| Install an app | Click **Install app** on any `app` item |
| Adopt a spec template | Click **Adopt spec** on any `spec` item |
| Update a marketplace | Click **Sync** in its section header |
| Remove a marketplace | Click **Remove** in its section header |
