# Scratchpad

The scratchpad gives the assistant a place to jot short, structured notes
within a single conversation. Unlike [memory](../memory/how-memory-works.md),
it is **conversation‑scoped** — notes belong to the chat they were written in
and do not follow you into other conversations. Unlike a plain text reply,
notes are addressable by title, so the assistant can update or delete them by
name later in the same chat.

Typical uses:

- Draft the outline of a longer answer before writing it out
- Track running decisions or open questions during a multi‑step task
- Cache intermediate results so later steps don't have to re‑derive them

---

## The four tools

The assistant sees four actions. All operate on the current conversation only.

| Tool | Parameters | Behaviour |
|------|------------|-----------|
| `scratchpad_write` | `title`, `content` | Create a note. Fails if `title` already exists in this conversation. |
| `scratchpad_read` | `title` (optional) | With no title, returns the list of notes (metadata only). With a title, returns that note in full. |
| `scratchpad_edit` | `title`, `content` | Replaces the content of an existing note. Fails if no note has that title. |
| `scratchpad_delete` | `title` | Removes a note by title. Immediate — no confirmation. |

Titles are unique within a conversation. Content can be any text, including
the empty string.

---

## Persistence

Notes survive a page reload of the same conversation. They **do not** cross
conversations: opening another chat starts with an empty scratchpad, and
switching back restores that conversation's notes exactly as they were.

There is no separate log file — the scratchpad is derived from the tool calls
already recorded in the conversation's history. Deleting or renaming the chat
therefore also removes its notes.

---

## Limits and caveats

- The scratchpad is text‑only. No attachments, formatting is up to the model.
- Errors are surfaced as structured results (`NOTE_NOT_FOUND`, `NOTE_EXISTS`,
  `INVALID_TITLE`) so the assistant can react without further prompting.
- Because state is reconstructed from the conversation on demand, very large
  histories with thousands of scratchpad operations may take a moment to
  hydrate on first access after a reload.
