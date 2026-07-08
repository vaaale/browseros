# Building apps

One of the most powerful things you can do in BOS is ask the assistant to **build
a new app**. It generates the app, installs it, and an icon appears on your
desktop.

> Building apps (and any coding) is done by the **Claude Developer** sub‑agent —
> never the local model. You'll need a working
> [Dev Harness](../settings/dev-harness.md).

---

## Just ask

> "Build me a pomodoro timer."

> "Make a small markdown notes app that saves to my files."

The assistant will (briefly) consider the best approach, delegate the build to the
Developer, and install the result. On install, the app gets a fitting icon and the
desktop refreshes so the icon shows up.

---

## What an app is

An installed app is a **self‑contained app** that runs in a window (in a sandboxed
frame). Two shapes are supported:

- **Simple** — a single self‑contained HTML page (all CSS/JS inline).
- **Project** — a multi‑file TypeScript/React project that BOS **bundles** at
  install time. Use this for anything non‑trivial (components, state, real UI).

Apps can call BOS's own same‑origin APIs (for example, to read and write your
files), so an app can integrate with the rest of the OS.

---

## Preview before it goes live

When BOS runs under its **Supervisor** (live version control), a newly built app
is installed as a **preview** first. You can try it, then **Promote** it (make it
live) or **Discard** it from the version controls in the top bar. Outside the
Supervisor, apps install live immediately. See
[Live version control](../versions/live-version-control.md).

---

## Managing installed apps

From **Settings → Apps** (or by asking the assistant):

- **Uninstall** — hide the app but keep its files (restorable).
- **Restore** — bring it back.
- **Purge** — delete its files permanently.

Installed apps are **versioned**: every install/uninstall/restore/purge is recorded,
so apps are durable, portable content separate from the OS itself.

---

## Tips

- Be specific about features, look, and whether it should save data.
- You can iterate: "make the timer's font bigger" or "add a reset button."
- Ask the assistant to **document** the app afterward and it'll add a page to the
  in‑OS [Docs](../apps/docs.md) hub.
