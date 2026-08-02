# Using the Assistant

Open **Assistant** from the desktop or dock. This page explains the chat, the side
panels, and how the assistant shows its work.

---

## Conversations (left panel)

- **New conversation** — starts a fresh thread.
- **Switch** — click any conversation to resume it; its messages reload from disk.
- **Delete** — remove a conversation you no longer want.

Each conversation is saved as a file in your VFS (`Documents/Chats/<id>.json`),
so history survives reloads. New conversations get an **auto‑generated title**
after the first exchange (you can rename them; your title is never overwritten).

You can hide the panel with the **left‑panel** button in the chat header.

---

## The chat (center)

Type a request in plain language and send it. The assistant streams its response,
rendering:

- **Markdown** — formatted text, lists, tables, links.
- **Code blocks** — with syntax highlighting.
- **Inline HTML previews** — fenced ```` ```html ```` blocks render in a sandboxed
  frame.
- **MCP‑UI panels** — some MCP tools return interactive HTML, also shown safely in
  a sandbox.

A **Working… / Ready** indicator in the header tells you whether the assistant is
busy or finished.

### Talking and listening

The buttons to the left of the message box control voice:

- **Microphone** — speak instead of typing. How it activates (push‑to‑talk, a wake
  word, or holding a key) is set in **Settings → Voice**.
- **Speaker** — turn spoken replies on or off. When it's on (green), the assistant
  reads its answers aloud, whether you typed them or spoke them; click it again to
  mute, which also silences whatever is playing right now.
- **Video** — only shown if you have an avatar installed (such as Live Avatar).
  Turning it on opens a small window in the upper left with the assistant's face,
  already connected, and speaks replies through it. Turning it off keeps spoken
  replies and just closes the face.

Spoken replies start off, and stay off until you ask for them. These buttons are
the only switches for output — Settings covers the voice, engine and microphone
behaviour, not whether voice is on at the moment.

A few things worth knowing:

- Closing the face window is the same as switching the video button off; you keep
  audio.
- Switching the speaker off closes the face too, since video includes sound.
- If the avatar can't connect, the window tells you why and offers to continue with
  audio only — you never end up with a silent assistant.
- The face doesn't come back by itself after a page reload (nor does any window).
  Your audio preference does.
- Any window, the face included, can be pinned on top with the pin button at the
  right of its title bar — handy for keeping the assistant visible while you work
  in another window.

### Live activity cards

The assistant doesn't just give you a final answer — it shows its work **as it
happens** as collapsible cards:

- **Thinking / reasoning** — the model's reasoning (for models that expose it).
- **Tool calls and results** — each action it takes (open app, read file, …).
- **Sub‑agent activity** — when it delegates, the sub‑agent's own steps stream in,
  **nested** under the delegation so you can see who did what.

A card expands when its event arrives and **auto‑collapses** shortly after (or when
the next event comes in), leaving just a heading. You can click any card to expand
or collapse it manually at any time.

---

## Tools / Skills / MCP (right panel)

Three tabs describe what the current agent has available:

- **Tools** — the actions the assistant can take, grouped by area (OS, Files,
  Config, Sub‑agents, Memory, Skills, MCP, Dev, Docs, Assistant, Workflows).
- **Skills** — the reusable procedures in the library, with a one‑line summary
  each. See [Skills](../self-improvement/skills.md).
- **MCP** — connected MCP servers and a live **connected / disconnected** status
  for each.

Hide the panel with the **right‑panel** button in the header.

---

## If the assistant can't respond

If no AI provider key is set, the chat shows a banner ("No API key set …") with a
button to open **Settings → AI Provider**. Add a key (or point at a local model)
and try again. See [AI Provider](../settings/ai-provider.md).

---

## Reasoning ("thinking") models

If you use a reasoning model that "thinks" before answering, BOS surfaces that
reasoning as a **thinking** card. Make sure **max output tokens** is large enough
in Settings — these models spend tokens on hidden reasoning first, and too small a
cap can yield an empty reply. See [AI Provider](../settings/ai-provider.md).
