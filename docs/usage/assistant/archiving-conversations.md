# Archiving conversations

When your conversation list gets long, **archive** the threads you're done with.
Archiving moves a conversation out of the default list without deleting anything
— every message is preserved, and you can bring it back at any time.

---

## Archive a conversation

**In the Assistant app** (left panel): hover the conversation, open its **⋯**
menu, and choose **Archive**. The conversation disappears from the default list
and moves into the **Archived** section at the bottom of its agent's list. The
section is **collapsed by default** — archived chats stay out of the way at
rest; click its header (chevron + count badge) to expand or collapse it.

**In Build Studio** (toolbar): the **archive button** next to the conversation
dropdown archives the currently selected conversation. Archived conversations
**do not appear in the dropdown at all** — to restore one, use the read-only
banner (if you still have it open) or the Assistant app's Archived section.

Archive state is shared everywhere: archiving a conversation in one app hides it
in every app that lists conversations, immediately, with no refresh.

---

## Archived conversations are read-only

You can still open and read an archived conversation — expand the Archived
section and click it. Everything is intact, but the message box is locked and a
banner explains why:

> This conversation is archived and read-only. Nothing has been deleted.

To continue the conversation, unarchive it first — the banner's
**Unarchive to continue** button does this in one click. The lock is enforced by
the server, so no send path can write to an archived conversation.

If you archive the conversation you currently have open, it stays open (read-
only) — archiving never switches you to a different thread.

---

## Restore (unarchive)

Any of these puts a conversation back in the default list, exactly as it was:

- The **⋯ menu → Unarchive** on a row in the (expanded) Archived section.
- The **Unarchive to continue** button in the read-only banner.

Build Studio has no unarchive affordance of its own — its dropdown never lists
archived conversations. Restore from the Assistant panel (or the banner) and
the conversation reappears in the Build Studio dropdown immediately, since both
apps share one archive state.

---

## Auto-archive on promote

When you **promote a feature branch** (desktop topbar or Settings → Versions),
every conversation whose **Active feature branch** is that branch is archived
automatically — the work is done, so the thread tidies itself into the Archived
section. Nothing is deleted: it behaves exactly like a manually archived
conversation and can be restored the same way. If you unarchive it afterwards,
it stays unarchived.

---

## Notes

- Archiving is **never destructive**: nothing is truncated or lost, and an
  archive → unarchive round-trip restores the conversation bit-for-bit.
- Archived conversations stay archived until you unarchive or delete them —
  there is no auto-cleanup.
- **Delete** (from the same ⋯ menu) still permanently removes a conversation,
  archived or not.
