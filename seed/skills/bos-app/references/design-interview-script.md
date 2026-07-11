# BOS App Design Interview Script

Use this script to gather requirements for a `bos-app`. Ask the questions in order; confirm each answer before moving on. Record confirmed answers directly into the spec.

---

## 1. Problem and user

- "What problem does this app solve?"
- "Who is the primary user? Is it the BOS owner, an agent, or another app?"
- "In one sentence, what does a successful session with this app look like?"

## 2. Core jobs to be done

- "What are the 3–5 most important things the user can do in the app?"
- "Which of those is the 'main' job — the reason the app exists?"
- "What triggers the user to open the app?"

## 3. Entities and data

- "What are the key nouns in this app?" (e.g. tasks, files, notes, credentials, schedules)
- "Does the app own the data, display data from elsewhere, or both?"
- "Is the data per-user, per-conversation, per-session, or global?"
- "How long-lived does the data need to be?"

## 4. UI surfaces

- "Does the app need its own window, or could it be a Settings tab / modal / panel inside another app?"
- "What is the main screen layout?" (list, sidebar + detail, canvas, dashboard, etc.)
- "What modals, sheets, or popovers are needed?"
- "Does it need a compact/tray mode or a full window?"
- "Should it be a singleton (only one window) or multi-window?"

## 5. Persistence and state

- "What state can be lost on reload, and what must survive?"
- "Does it need user settings? If yes, a config namespace is usually the right place."
- "Does it need server-side storage? If yes, prefer an existing store (config, VFS, memory/skills) before inventing a new `src/lib/...` store."
- "Does it need to read or write files in the VFS?"

## 6. Assistant integration

- "Should the assistant be able to control this app?"
- "What actions make sense as Tier 1 (installed-app) tools that appear in Settings → Agents → Tools?"
- "What actions only make sense while the app window is open (Tier 2 runtime surface tools)?"
- "Should the app react to agent messages or only to explicit tool calls?"

## 7. Integrations and dependencies

- "Does this app depend on other BOS subsystems?" (memory, integrations, scheduler, logging, etc.)
- "Does it call external APIs? If yes, use the integrations framework; do not hardcode credentials."
- "Does it need to run background work? If yes, consider the scheduler or a server-side worker."

## 8. Out of scope and constraints

- "What is explicitly out of scope for the first version?"
- "Are there offline/online, performance, or security constraints?"
- "Does this require a constitution change? If yes, pause and collaborate on alternatives."

## 9. Approval prompt

Summarize back to the user:

"So the app is `<name>`, a `<built-in | installed>` app that lets `<user>` `<main job>`. The key surfaces are `<list>`, persistence is handled by `<mechanism>`, and the assistant tools are `<list>`. Out of scope: `<list>`. Does that sound right?"

Proceed to functional design only after the user confirms.
