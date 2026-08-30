# How memory works

BOS gives the assistant a **self‑improving memory** so it stops you repeating
yourself and gets better at recurring tasks. This page explains the model; to view
or edit entries, use the [Memory app](../apps/memory.md).

---

## Two durable surfaces

Long‑term knowledge is split into two clearly‑labeled surfaces:

- **User profile** — *who you are*: identity, role, durable preferences,
  communication style, expectations about how the assistant should behave.
- **Agent memory** — *the assistant's notes*: environment facts, project
  conventions, tool quirks, and durable lessons.

A third kind of knowledge — **how to do a class of task** — is **not** memory; it
becomes a **[skill](../self-improvement/skills.md)**. Keeping these separate is
deliberate: memory answers "who/what is the situation," skills answer "how to do
this."

---

## Always available, not searched

The memory surfaces are small and **always injected** into the assistant's
instructions at the start of a conversation — so the assistant just *knows* them,
without having to search.

- The injection is a **frozen snapshot** captured when the conversation begins.
- Entries you add mid‑conversation are saved immediately but take effect in your
  **next** conversation. This keeps the assistant's behavior stable within a chat
  (and keeps it efficient).

---

## Bounded on purpose

Each surface has a **character budget** (small by design — roughly a couple
thousand characters for agent memory, less for the user profile). This forces
**high‑signal, consolidated** entries instead of an ever‑growing log.

If a new entry would exceed a topic's budget, the write still **succeeds** — it
isn't rejected or silently truncated. The topic is instead flagged so the
assistant's background consolidation pass reorganizes it (merging overlapping
entries, dropping stale ones, or splitting it into a more focused topic) the
next time it runs. The assistant can also tidy a topic itself at any time,
using its own edit tools to update or remove specific entries rather than
appending endlessly.

---

## What gets saved (and what doesn't)

**Saved** (proactively):

- Preferences and corrections ("I prefer metric units", "don't be so verbose").
- Personal/identity details and how you like to work.
- Stable facts about your environment, conventions, and tools.

**Not saved**:

- Trivial or easily re‑discoverable facts.
- Raw data dumps, task progress, or one‑off task narratives.
- **Transient or environment‑specific failures** (a missing tool, a one‑time
  error). Hardening these into memory would make the assistant wrongly refuse
  things later — so it captures the *fix*, not "X is broken."
- Reusable procedures → those go to a **skill**.

---

## Finding things: search, not just recall

When the assistant searches its memory, results are ranked by how relevant,
recent, and important they are — not just whether a word matches. This
combines a semantic (meaning-based) signal with a keyword signal, so a
paraphrased question can still find the right memory even without shared
words, while an exact-keyword search still works too. Irrelevant results are
left out rather than guessed at.

The semantic signal needs an **embeddings endpoint**, configured alongside
your AI provider in Settings → AI Provider. If you leave its base URL and API
key blank, it reuses your main provider's; you only need to set a model name
to turn it on. If your provider doesn't support embeddings (e.g. a
pure-Anthropic setup with no override), search still works — it just falls
back to keyword + recency + importance ranking automatically, with no error.

## Correcting the record

When you tell the assistant something that contradicts an earlier memory (for
example, your job changed), the assistant marks the older entry as no longer
current rather than deleting it or leaving both side by side. Day-to-day, you
only ever see the current one; the older entry is kept (labeled "not
current") so history isn't lost.

---

## Where it's stored & safety

Memory is stored as plain files on the host (the user profile and agent notes),
so it's durable and inspectable. Because memory is injected into the assistant's
instructions, new entries are screened for **prompt‑injection** patterns and
refused if they look like an attack — you can rephrase and re‑add.

You're always in control: review and remove anything from the
[Memory app](../apps/memory.md).
