# Memory

The **Memory** app is the control panel for everything the assistant remembers —
durable knowledge that is **injected into the assistant at the start of every
conversation**, so you never have to repeat yourself. It also exposes the
automated **memory loops** that summarise your conversations into episodes and
consolidate them into long-term, topic-sharded memory.

For the concepts behind this (budgets, when things get saved, how it's injected),
see [How memory works](../memory/how-memory-works.md).

---

## The five tabs

The app is organised as five tabs across the top:

| Tab | What it shows | Who writes to it |
|---|---|---|
| **Profile & Notes** | `USER.md` + `MEMORY.md` — the always-injected snapshot | You, the assistant, and the slow loop |
| **Episodes** | Per-conversation review notes (`/Documents/Memory/Episodes/`) | The **fast loop** |
| **Topics** | Topic-sharded long-term memory (`/Documents/Memory/Topics/*.md`) | The **slow loop** |
| **Memory Loops** | Configuration + manual run controls for both loops | You (config only) |
| **Search** | Cross-surface search across Topics, Episodes, and MEMORY.md | Read-only |

The header shows a live count of **Pending / Consolidated / Topics** so you can
see at a glance whether the loops are keeping up.

---

## Profile & Notes

Two side-by-side panes. Each pane has its own budget bar (green / amber / red)
and an **Add** button.

- **User Profile** (`USER.md`, 1 200 char budget) — *who you are*: role, durable
  preferences, communication style, expectations.
- **Agent Notes** (`MEMORY.md`, 2 000 char budget) — *the assistant's own notes*:
  environment facts, conventions, tool quirks, and lessons it has learned.

To add an entry, click **Add**, type into the box, then press **Ctrl+Enter**
(or click **Save**). Press **Escape** to cancel. To remove an entry, hover it
and click the trash icon; you'll be asked to confirm.

> **When new entries take effect.** Memory is captured as a *frozen snapshot* at
> the start of each conversation. Anything you (or the assistant) add
> mid-session is saved to disk immediately, but it influences the assistant
> starting from your **next** conversation. The banner in the app reminds you of
> this.

The **slow loop** may also add, replace, or remove entries here when it
consolidates episodes into durable lessons.

---

## Episodes

The **fast loop** wakes up every ~2 minutes, scans your conversations, and
writes one review per idle conversation per day into `Episodes/`. Each episode
records what worked, what failed, corrections received, durable lesson
candidates, and profile suggestions.

The left pane lists episodes with filter chips: **All / Pending /
Consolidated**. A *Pending* episode hasn't been through the slow loop yet; a
*Consolidated* one has already been folded into topic memory. Click any episode
to see its full detail on the right.

From the detail pane you can:

- **Review Now** — triggers the fast loop for that conversation immediately
  (`POST /api/assistant/reflect`). Useful if you want to force a fresh review
  without waiting for the next tick.
- **Archive** — move a consolidated episode to `.Archive/` (only enabled once
  it's been consolidated).
- **Delete** — permanently remove the episode file.

Use **Previous / Next** at the bottom to walk through episodes without going
back to the list.

**Practical example.** You just finished a debugging session and want the
assistant to remember the lesson before your next chat: open **Episodes**, find
today's file, click **Review Now**. When the review completes, the episode
appears in *Pending* (or is updated in place). Run the slow loop from the
**Memory Loops** tab to fold it into `Topics/` immediately.

---

## Topics

Topics are the long-term memory surface. Each topic is a shard at
`/Documents/Memory/Topics/<slug>.md` with a 4 000 character budget (configurable
under **Memory Loops → Advanced**). `MEMORY.md` keeps a one-line pointer per
topic so the always-injected snapshot stays small.

- **Left pane** — searchable list of topics with entry count and per-topic
  budget bar. Click **New** to create a topic manually.
- **Right pane** — numbered entries for the selected topic. Each entry shows
  when it was added and its stable id.

You can **Add Entry** (Ctrl+Enter to save), delete individual entries, or
delete the whole topic. Adds are validated against the per-topic budget — if
the entry wouldn't fit, the draft box flags it before you save.

Most entries here are written by the **slow loop** from your episodes. Topics
are also what powers `memory_recall("<slug>")` — the assistant can pull the
full shard on demand.

**Practical example.** You want to see what the assistant has learned about
your Postgres migration patterns: open **Topics**, search "postgres" or
"migrations", pick the shard, and read the entries. Delete anything that's
stale — the assistant will pick up your edits on the next conversation.

---

## Memory Loops

The configuration and manual-trigger surface for both automated loops.

**Fast Loop** — runs every couple of minutes.

- **Enable Fast Loop** toggle
- **Tick Interval** — how often it wakes up (default 120 s)
- **Idle Threshold** — how long a conversation must be idle before it's
  eligible (default 300 s)
- **Unreviewed Turn Cap** — force a review after this many new turns even if
  the conversation isn't idle (default 40)
- **Min New Turns to Review** — skip conversations with fewer new turns
  (default 4)

**Slow Loop** — runs hourly.

- **Enable Slow Loop** toggle
- **Interval** — how often it runs (default 3600 s)
- **Batch Size** — max pending episodes processed per run (default 10)

**Advanced Settings** apply to both.

- **Episode Archive Age (days)** — consolidated episodes older than this move
  to `.Archive/` (default 14).
- **Topic Budget (chars)** — per-topic character cap (default 4 000).
- **Model Override** — pin a specific model for both loops (leave blank to
  use the provider default).

Underneath the config, **Run History** shows the latest execution summary for
each loop (scanned / reviewed / consolidated counts, refusals, errors) pulled
from the central log. The two **Run … Now** buttons force an immediate run —
handy when you've just changed configuration or want to fold a fresh episode
in without waiting.

A coloured banner at the bottom reflects loop status:

- **Green** — both loops enabled; changes take effect on the next tick.
- **Amber** — one or both loops disabled; you'll need to trigger them manually.

**Practical example.** Fast loop feels too aggressive on a chatty week: bump
**Min New Turns to Review** from 4 to 8, click **Save Configuration**. The next
tick will use the new threshold.

---

## Search

A single search box across every memory surface. Results are ranked by
relevance (token match count for now — BM25 is a drop-in swap later) and
grouped by source.

- Type at least 2 characters; results stream in with a short debounce.
- Filter chips **All / Topics / Episodes / Memory** narrow by source; each chip
  shows a count so you can see the split before clicking.
- Matched terms are highlighted in every hit.
- Each hit shows the source path with an anchor (`#entry-N` for topics,
  `#<section>` for episodes) so you can jump into the right tab and find it.
- **Load More Results** paginates when there are more matches than the initial
  page.

**Practical example.** You want to find every mention of a colleague's name
across everything the assistant knows: type the name, leave the filter on
**All**, and skim the ranked hits. Switch to **Topics** to see only durable
mentions; switch to **Episodes** to see recent session-level context.

---

## How the tabs work together

```
 conversation activity
        │
        ▼
 ┌────────────────────┐
 │     Fast loop      │  writes → Episodes tab
 │  (every ~2 min)    │
 └─────────┬──────────┘
           │  pending episodes
           ▼
 ┌────────────────────┐
 │     Slow loop      │  writes → Topics tab
 │      (hourly)      │  updates → Profile & Notes
 └─────────┬──────────┘  archives → Episodes/.Archive/
           │
           ▼
   Everything above is queryable from the Search tab.
```

- The **fast loop** captures per-conversation reviews into **Episodes**.
- The **slow loop** consumes pending episodes and writes into **Topics**
  (long-term memory) and, when appropriate, into **Profile & Notes** (durable
  preferences). It also archives old episodes.
- **Memory Loops** controls the cadence and budgets of both.
- **Search** reads everything the loops (and you) have written.

---

## Who writes to memory

- **You**, in every tab except Search.
- **The assistant**, via its memory tool — it saves proactively when you state
  a preference, a correction, or a personal detail.
- **The fast loop** — writes only to `Episodes/`.
- **The slow loop** — writes to `Topics/` and to `USER.md`/`MEMORY.md`
  (incremental add/replace/remove only), and archives old episodes.

Reusable *procedures* are deliberately **not** stored as memory — those become
**skills** instead. See [Learning from experience](../self-improvement/learning-from-experience.md).

---

## Safety

Because Profile & Notes are injected into the assistant's instructions, BOS
screens new entries for obvious prompt-injection patterns and refuses to store
them. If a write is refused, rephrase the entry. The loops themselves are
restricted to incremental ops (no full-file rewrites) and — for the fast loop —
a small, allowlisted toolset.
