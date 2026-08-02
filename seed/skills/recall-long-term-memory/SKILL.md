---
name: Recall Long-Term Memory
description: Retrieve durable lessons and topic knowledge from long-term memory using memory_search and memory_recall.
when_to_use: Before starting a task in a domain you might have worked in before, or when a lesson/pattern might already exist for the current problem.
created_by: seed
---

Long-term memory in BrowserOS has four surfaces:

1. **USER.md** — who the user is (always injected).
2. **MEMORY.md** — global notes + a one-line INDEX of topic shards (always injected).
3. **Topic files** at `/Documents/Memory/Topics/<slug>.md` — detailed knowledge on a subject, retrieved on demand.
4. **Episodes** at `/Documents/Memory/Episodes/<yyyy-mm-dd>-<convId>.md` — recent conversation summaries (short-term buffer).

Use these tools:

## `memory_search(query, maxResults?)`

Case-insensitive substring search across topics and episodes. Returns `[ { source, content, score } ]` where `source` is a VFS path with an in-file anchor (e.g. `/Documents/Memory/Topics/gmail-workflows.md#entry-3`). Higher score = more matching tokens.

WHEN to use: when you know keywords but not the topic slug, or when a lesson might span domains.

Examples:
- `memory_search("Gmail OAuth scope requirements")`
- `memory_search("Drive file monitoring", 5)`

## `memory_recall(topic?)`

Without a topic: returns USER, MEMORY, and the list of topic slugs.
With `topic="<slug>"`: returns the topic file's digest + entries.

WHEN to use: when you know the topic slug (check MEMORY.md's index) and want its full contents.

Examples:
- `memory_recall()` — see what topics exist.
- `memory_recall(topic="gmail-workflows")` — load all gmail-workflows entries.

## Provenance and Confidence

- **Topic entries** are consolidated across multiple conversations — treat as durable.
- **Episode entries** are recent and may be refined later — treat as tentative.
- Newer entries supersede older ones; look at the timestamp `[yyyy-mm-dd]`.

## Typical Flow

Before a task in a familiar domain:
1. `memory_recall()` to see topics.
2. If a relevant topic slug exists, `memory_recall(topic="<slug>")`.
3. Otherwise `memory_search(...)` with the key nouns.
4. Apply lessons; if you learn something new, the fast/slow loops capture it automatically — no manual save needed for lessons and workflow corrections.

Manual `memory_save` still exists for user identity and urgent memory writes; skip it for anything the loops will capture.

## Troubleshooting

- Empty `memory_search` result → try broader keywords, or the knowledge hasn't been consolidated yet (fast loop → 2 min; slow loop → hourly).
- Contradictory entries → newer timestamp wins; the slow loop should have superseded the old one.
- Topic not found → check `memory_recall()` for the exact slug (lower-kebab).
