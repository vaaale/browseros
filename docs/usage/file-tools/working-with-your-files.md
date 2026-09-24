# Working with your files

The assistant can read and write files for you — the same files you see in the
**Files** app. This page explains what it can reach, what it cannot, and the one
rule that trips people up (specs and docs need a feature branch).

---

## What the assistant can reach

Everything in your virtual file system: `/Documents`, `/Pictures`, `/Desktop`,
and anything else you create. Ask in plain language — you never name a tool:

> "What's in my Documents folder?"
> "Read `/Documents/notes.md` and summarise it."
> "Save that as `/Documents/summary.md`."
> "Move the screenshots into a folder called Trip."

Behind the scenes it has eleven file operations: list, read, write, make a
folder, delete, rename/move, two precise editing tools, and three search tools.

### Searching

There are three ways to find things, and the assistant picks between them:

- **Find files by name or pattern** — "find every markdown file under
  /Documents".
- **Search text across a folder** — "which of my notes mention Vaagan?"
- **Search inside one file** — "find every TODO in `/Documents/plan.md`", with
  surrounding lines for context.

Searching a folder only looks inside text-like files (`.md`, `.txt`, `.json`,
`.ts`, and similar). Searching **one named file** has no such restriction.

### Editing

When changing a file that already exists, the assistant edits it in place rather
than rewriting it wholesale. If the text it is asked to replace appears more than
once — or not at all — **it stops and asks** instead of guessing. That is
deliberate: a wrong guess silently corrupts the wrong part of your file.

---

## What the assistant cannot reach

**BrowserOS's own source code.** The file tools see your documents only. This is
a hard boundary, not a permission you can grant.

That is not a limitation on what you can ask for — it is just a different route.
If you ask the assistant to change BrowserOS itself, or to build or modify an
app, it hands the work to the **developer sub-agent**, which does have source
access and works on a feature branch. See
[Modifying BOS](../building-and-modifying/modifying-bos.md).

If you ever see the assistant hunting through `/Documents` for BrowserOS's code,
something has gone wrong — say so, and it will delegate instead.

---

## Special folders: `/Specs`, `/Docs`, `/Methods`

Three folders in your file system are not ordinary folders.

| Folder | What it is | Can the assistant write to it? |
|---|---|---|
| `/Specs/user-specs` | Your specifications | Yes — **with an active feature branch** |
| `/Specs/bos-system-specs` | The specs BrowserOS ships with | **Never.** Read-only |
| `/Docs` | This documentation | Yes — with an active feature branch |
| `/Methods` | Installed spec-framework templates | No — read-only |

### The feature-branch rule

`/Specs` and `/Docs` are version-controlled. Writing to them requires an **active
feature branch** on your conversation — the same branch used for BrowserOS's own
source, so a spec change and the code change that implements it travel together.

If none is set, a write is **refused**, with a message about no active feature
context. The assistant handles this for you: it proposes a branch name, you
confirm or edit it, and work continues. Nothing is lost and nothing is written
to the wrong place.

Reads work either way. With a branch active, you see that branch's version of a
file — including edits made in this session that are not merged yet. Without
one, you see the base version. **So the same path can legitimately show
different content depending on which feature you are working on.** That is the
system working, not a bug.

Writes to `/Specs` are committed automatically, a couple of seconds after the
last change, on your feature branch.

### Moving files in and out

You cannot move a file between `/Specs` (or `/Docs`, or `/Methods`) and an
ordinary folder in one step — the assistant will tell you it cannot rename
across the boundary. They are genuinely different storage systems. Read the
content and write it to the new location instead.

---

## Good to know

- **Writing creates folders.** Saving to `/Documents/trips/2026/notes.md` makes
  the missing folders for you.
- **Writing replaces.** It overwrites the whole file rather than appending. Ask
  for an edit if you want to change part of a file.
- **Deleting a folder deletes what is in it**, and cannot be undone from the
  assistant. It will not delete the root of your file system.
- **Nothing is half-written.** A file is written completely or not at all, even
  if BrowserOS is interrupted mid-write.
- **The assistant works even when you are not watching.** Scheduled jobs,
  self-healing and Build Studio run without a browser window open, and have the
  same file access you do. (They did not always — see below.)

---

## If something looks wrong

- **"It says my file is empty."** It should not — a missing or unreadable file
  reports an error rather than blank content. If you see "empty", the file
  probably is.
- **"It can't find a spec I know exists."** Check the active feature branch on
  the conversation. A spec written on one branch is not visible from another.
- **"It says it can't write to a spec."** Either no feature branch is active, or
  the path is under `/Specs/bos-system-specs`, which is never writable. Your own
  version of a shipped spec goes in `user-specs`.

---

## Related

- [The Files app](../apps/files.md)
- [Using the assistant](../assistant/using-the-assistant.md)
- [Delegation & sub-agents](../assistant/delegation-and-sub-agents.md)
- [Modifying BOS](../building-and-modifying/modifying-bos.md)
