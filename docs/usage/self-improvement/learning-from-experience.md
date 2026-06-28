# Learning from experience

BOS's assistant is designed to **get better over time** — from your feedback and
from its own experience. It does this by updating two things: its
**[memory](../memory/how-memory-works.md)** (who you are, the current situation)
and its **[skills](skills.md)** (how to do a class of task).

---

## The reflection / review pass

After a non‑trivial task, the assistant can run a **self‑improvement review** — a
**separate** pass that replays the finished conversation and asks: *"Is there
anything worth saving so the next session is better?"*

- It runs with a **restricted toolset**: it can only touch **memory** and
  **skills** — it takes no other actions and doesn't change the live chat.
- It **saves to memory** when you revealed a durable preference, detail, or
  expectation.
- It **updates skills** when you corrected the assistant's style or a workflow, or
  when a useful technique/fix emerged — preferring to *patch an existing skill*
  over creating a new one.
- For a smooth session with nothing new, "**nothing to save**" is a perfectly valid
  outcome.

You'll typically see this happen after the assistant completes a task; you can also
ask it to "reflect on what you just did and save anything useful."

> The review is careful **not** to harden transient or environment‑specific
> failures into permanent rules — those would make the assistant wrongly refuse
> things later.

---

## Improving a skill from feedback (GEPA)

When you give feedback about an approach or a specific skill ("this skill missed a
step", "do it this way next time"), the assistant can **improve that skill**: it
reflectively rewrites the skill's instructions to incorporate the lesson and tracks
a **score** for the new version. Just tell it — e.g. "improve the web‑summary skill:
always include the source URL."

---

## Keeping the library tidy: the Curator

Continuously creating skills would clutter the library, so a **Curator** maintains
it:

- It **archives** (never deletes) skills that have gone unused for a long time.
- Archives are **recoverable**.
- It only touches **agent‑created** skills — built‑in/seeded skills and any skill
  you've **pinned** are left alone.

The Curator runs on demand (e.g. you can ask the assistant to "tidy up stale
skills"). Pinned skills can still receive improvements; pinning only protects them
from being archived.

---

## You stay in control

- Everything the assistant learns is visible: memory in the
  [Memory app](../apps/memory.md), skills in **Settings → Skills**.
- The learning passes take no real‑world actions — they only curate memory and
  skills.
- You can edit or remove anything it has saved.
