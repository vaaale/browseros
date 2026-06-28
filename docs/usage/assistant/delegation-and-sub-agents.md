# Delegation & sub‑agents

The BOS assistant is an **orchestrator**: rather than doing everything itself, it
**delegates** substantive work to **sub‑agents** — focused specialists. This is
why you see nested activity in the chat (the assistant, then a sub‑agent's steps
under it).

---

## Local vs. Claude sub‑agents

- **Local sub‑agents** run on **your configured AI provider** (the same model that
  powers the chat). They handle general tasks: research, writing, file
  organization, planning.
- **Claude sub‑agents** run **Claude Code** and are used for **all
  development/coding** — building apps and modifying BOS itself. Development is
  Claude‑only by design; the assistant will not write code with the local model.

The built‑in **Developer** agent is a Claude sub‑agent. See
[Building & modifying things](../building-and-modifying/building-apps.md).

---

## The Claude‑for‑non‑dev permission prompt

Claude sessions cost real Claude usage, so they're reserved for development. If the
assistant wants to use a **Claude** agent for a **non‑development** task, it must
**ask your permission first**. You'll see a card offering:

- **Allow once** — use Claude for just this task.
- **Allow this session** — allow it for the rest of this session.
- **Use Local** — decline and use the local model instead.

For development tasks, no prompt is needed — Claude is expected.

---

## Creating sub‑agents on the fly

If no suitable sub‑agent exists for a task, the assistant can **create one** — either
a reusable agent (saved for later) or a one‑off **ephemeral** agent that exists only
for that task. You can also pre‑create agents in **Settings → Assistant**.

---

## What you'll see in the chat

When the assistant delegates, the chat shows the delegation as a card and then
streams the sub‑agent's **own** steps (thinking, tool calls, results) nested
beneath it — live, as they happen, not batched at the end. This makes it clear who
is doing what at each stage.

---

## If the Claude harness isn't available

Development needs a working **Dev Harness** (how Claude Code runs — see
[Dev Harness](../settings/dev-harness.md)). If it isn't configured or reachable,
the assistant will tell you plainly rather than silently falling back to writing
code with the local model.
