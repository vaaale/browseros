# Skills

A **skill** is a named, on‑demand **procedure** — reusable instructions for *how to
do a class of task*. The assistant keeps a **library** of skills and consults the
relevant one before doing that kind of work. Skills are how the assistant's
*procedural* knowledge grows over time (distinct from
[memory](../memory/how-memory-works.md), which holds *who you are* and *the current
situation*).

---

## How the assistant uses skills

- The assistant always sees a lightweight **index** of skills (each skill's name +
  when to use it).
- When a skill is relevant, it **loads the full instructions** on demand and
  follows them.
- A skill can carry extra **scripts** and **references** (supporting files the
  assistant reads on demand).
- If a skill's procedure runs a bundled script, the assistant stages the skill's
  files into the sandbox and runs it there — this needs **[Command
  Execution](../settings/command-execution.md)** turned on.

You can see the current skills in the Assistant's right **Skills** panel.

---

## The Skills editor (Settings → Skills)

**Settings → Skills** is a full editor:

- **Browse** all skills.
- **Open** a skill to edit its **main file**: name, one‑line **description**,
  **when‑to‑use**, and the **instructions** body.
- **Add, edit, rename, or remove** its attached **scripts** and **references**.
- **Create** new skills and **delete** ones you don't want.

---

## What ships out of the box

- **Summarize a web page** — fetch a URL and produce a faithful summary.
- **Develop in BrowserOS** — the development skill. It triages between two
  use‑cases and points to a reference for each:
  - **Building an app** (a self‑contained app installed into BOS), and
  - **Modifying BOS itself** (changing the OS's own code).
  Both delegate to the Claude **Developer** sub‑agent.

---

## Where skills come from

- **You** create/edit them in the editor.
- **The assistant** creates and patches them through its
  [self‑improvement](learning-from-experience.md) loop — e.g. after you correct its
  approach, it embeds the lesson into the relevant skill so the next session starts
  already corrected.

Skills are **archived, never silently deleted** by the system, and you can **pin**
one to protect it from automatic archiving.
