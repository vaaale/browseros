# Memory

The **Memory** app shows what the assistant remembers — durable knowledge that is
**injected into the assistant at the start of every conversation**, so you never
have to repeat yourself.

Memory is split into two surfaces:

- **User profile** — *who you are*: identity, role, durable preferences,
  communication style, expectations.
- **Agent memory** — *the assistant's own notes*: environment facts, conventions,
  tool quirks, and lessons it has learned.

For the concepts behind this (budgets, when things get saved, how it's injected),
see [How memory works](../memory/how-memory-works.md).

---

## Using the app

Each surface lists its entries. You can:

- **Add an entry** — type into the box and click **Add** (or press Enter).
- **Remove an entry** — hover an entry and click the trash icon.

Entries are short, declarative statements. They persist across conversations and
reloads.

> **When new entries take effect.** Memory is captured as a *frozen snapshot* at
> the start of each conversation. Anything you (or the assistant) add mid‑session
> is saved to disk immediately, but it influences the assistant starting from your
> **next** conversation. This keeps the assistant's behavior stable within a
> single chat.

---

## Who writes to memory

- **You**, here in the app.
- **The assistant**, via its memory tool — it saves proactively when you state a
  preference, a correction, or a personal detail, or when it learns a stable fact
  about your environment.
- **The self‑improvement review**, a separate pass that runs after a task and
  records durable lessons. See
  [Learning from experience](../self-improvement/learning-from-experience.md).

Reusable *procedures* are deliberately **not** stored as memory — those become
**skills** instead.

---

## Safety

Because memory is injected into the assistant's instructions, BOS screens new
entries for obvious prompt‑injection patterns and refuses to store them. If a
write is refused, rephrase the entry.
