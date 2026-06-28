# Agents & personalities

The assistant's personality is defined by an **agent**. There is a single concept
of an "agent" in BOS — the main assistant simply adopts the **active agent's**
instructions as its personality. The same agents are also the specialists the
assistant **delegates** work to.

---

## Switching the active personality

- In the **chat header**, use the **agent selector** to pick the active agent.
- Or open **Settings → Assistant** to manage agents and choose which one is
  active.
- Or just ask: "switch to the Planner personality."

The default agent, **Assistant**, ships out of the box and is the active
personality until you change it.

---

## What ships out of the box

| Agent | Type | Role |
|---|---|---|
| **Assistant** | Local | The default main‑chat personality. |
| **Researcher** | Local | Gathers info from the web and summarizes. |
| **File Organizer** | Local | Tidies and organizes your files. |
| **Writer** | Local | Drafts and edits documents. |
| **Planner** | Local | Breaks a task into a plan with acceptance criteria. |
| **Developer** | Claude | Builds apps and modifies BOS's own code. |

"**Local**" agents run on your configured AI provider. "**Claude**" agents run
Claude Code and are used for development. See
[Delegation & sub‑agents](delegation-and-sub-agents.md).

---

## Editing and creating agents

In **Settings → Assistant** you can:

- **Edit an agent's instructions** (its system prompt / personality).
- **Create a new agent.**
- **Switch** the active one.

The assistant can also do these for you ("create a friendly tutor agent and make
it active"). Every agent's instructions are composed with BOS's always‑on core
policy and the current skills index, so even a custom personality still follows
the OS's safety rules and can use skills.

---

## How the personality is assembled

When you chat, the assistant's full instructions are composed from:

1. **Core policy** — the non‑negotiable BOS operating rules (delegation,
   Claude‑for‑development, the feature‑branch rule, memory guidance, …).
2. **The active agent's** personality.
3. Your **memory** snapshot (user profile + agent notes).
4. A **skills index** (names + when‑to‑use; full skill bodies are loaded on
   demand).

You can ask the assistant to show its current composed instructions, or to rewrite
the active agent's instructions, with its built‑in tools.
