# Settings → Tools

This page controls what your assistant's tools *look like to the model*. It does
not decide which agent may use which tool — that lives in **Settings → Agents →
[agent] → Tools**.

## Tool groups

Tools are organised into groups: Web, Files, Gmail, Scheduler, and so on. An
installed marketplace item that exposes tools brings its own group with it (the
Workflow Manager appears as *Workflows*, the OKF Knowledge Base as *Knowledge
Base*).

Groups start collapsed. Click one to expand it; the number beside the name is
how many tools it holds. Use the **Filter** box to search across tool names,
descriptions and group search terms — groups containing a match open
automatically.

## Why groups matter to the assistant

Your assistant's system prompt contains a short index of the groups it has,
with each group's description. Where a group holds tools that are *hidden* from
the assistant's starting context (marked **deferred** per-agent in Settings →
Agents), the index says how many are hidden and how to ask for them.

That means a group's description is doing real work: it is how the assistant
decides whether a family of tools is worth looking into at all, and it is one of
the signals its tool search ranks against. A vague description makes tools
harder for the assistant to find; a specific one makes them easier.

### Editing a group

Expand a group and you can edit:

- **Group description** — one line, in your own words. Replaces the built-in
  text everywhere: the system-prompt index and tool search both use it.
- **Aliases** — comma-separated extra search terms. Use these for words *you*
  would say that the description doesn't contain. If your team says "deck"
  rather than "presentation", add `deck`.

Changes save when you click away and take effect on the next message — no
restart. **Reset** restores the built-in text, and the original is shown
underneath as *Source:* while an override is active.

Edits to a marketplace item's group survive that item's service being stopped,
and come back when it starts again.

## Editing a single tool's description

Inside a group, each tool has its own editable description. This is the text the
model sees for that tool. Rewriting it is the most direct way to change how the
assistant uses a tool — for example, adding "only use this for internal
documents" to a file tool. **Reset** restores the built-in description.

## Discovery settings

At the top of the page:

- **Max discovery results** — how many results a natural-language tool search
  returns. Asking for a whole group by name always returns all of it, regardless
  of this number.
- **Tool call timeout** — how long a single tool call may run before it is
  aborted and reported to the assistant as an error.
- **Max agent steps** — how many model turns one agent gets per run. Delegated
  sub-agents each get this budget independently.

## If you see "Unresolved tool group"

A red block means some tools point at a group that doesn't exist. That is a bug
in whatever registered them — usually a marketplace item whose manifest declares
a different group id than its tools ask for. The tools are listed there rather
than quietly filed under a placeholder heading. Check **Settings → Services**
for an error on the owning item.
