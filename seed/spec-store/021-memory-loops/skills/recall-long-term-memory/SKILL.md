# Skill: Recall Long-Term Memory

**Purpose**: Teach the assistant how to retrieve information from long-term memory, including topic files and episodic memories

**Seeding**: This skill is added to the SEED list in `src/lib/agent/skills/store.ts` (`created_by: seed`) so both fresh and existing installs receive it.

---

## Overview

Long-term memory in BrowserOS now consists of:
1. **USER.md** - Your identity, preferences, role (always injected)
2. **MEMORY.md** - Global index + topic references (always injected)
3. **Topic files** (`/Documents/Memory/Topics/*.md`) - Detailed knowledge on specific subjects (retrieved on demand)
4. **Episodes** (`/Documents/Memory/Episodes/*.md`) - Recent consolidation candidates (searched for lessons)

This skill teaches you how to search and recall information from all these sources.

---

## Tools Available

### `memory_search(query: string, maxResults?: number)`

Search across topic files and episode lessons. Returns matching entries with provenance.

**When to use**: When you need to find information about a topic but don't know the exact topic name, or when searching for patterns across multiple memories.

**Examples**:
```
memory_search("Gmail OAuth scope requirements")
memory_search("workflow automation patterns", 5)
memory_search("Drive file monitoring best practices")
```

**What you get back**:
```json
[
  {
    "source": "/Documents/Memory/Topics/gmail-workflows.md#entry-3",
    "content": "Gmail API requires OAuth scope `https://www.googleapis.com/auth/gmail.modify` for label operations. Readonly scope insufficient.",
    "score": 2.5
  },
  {
    "source": "/Documents/Memory/Episodes/2026-07-05-abc123.md#lessons",
    "content": "Drive file monitoring is more efficient with `modifiedTime` search than folder polling",
    "score": 1.8
  }
]
```

### `memory_recall(topicSlug?: string)`

Recall all entries from a specific topic, or the global memory index if no topic specified.

**When to use**: When you know the topic name and want to see everything we've learned about it.

**Examples**:
```
memory_recall()                    // Global memory index
memory_recall("gmail-workflows")   // All Gmail workflow lessons
memory_recall("drive-integration") // All Drive integration patterns
```

**What you get back**:
```markdown
## Topic: gmail-workflows

- [2026-07-05] Gmail API requires OAuth scope `https://www.googleapis.com/auth/gmail.modify` for label operations. Readonly scope insufficient.
- [2026-07-06] Use `gmail_messages_search` with `q: "label:UNREAD"` instead of listing all messages (performance).
- [2026-07-07] Label creation requires admin consent for organization-wide labels.
```

---

## Usage Patterns

### Pattern 1: Search Before Starting a Task

**Scenario**: User asks you to set up a Gmail integration.

**Your workflow**:
1. First, search for existing knowledge: `memory_search("Gmail integration setup")`
2. Review the results for relevant patterns, pitfalls, OAuth requirements
3. Apply the lessons to your implementation
4. If you discover new lessons, they'll be captured in the episode and consolidated later

**Why**: Avoids reinventing the wheel; leverages past experience.

### Pattern 2: Recall Topic During Debugging

**Scenario**: You're implementing a workflow and hit an OAuth error.

**Your workflow**:
1. Recall the relevant topic: `memory_recall("gmail-workflows")`
2. Check if there's already a solution documented (e.g., "requires `.modify` scope, not `.readonly`")
3. Apply the fix; if it's a new lesson, it gets captured in the current episode

**Why**: Quick access to domain-specific knowledge without sifting through global memory.

### Pattern 3: Cross-Reference Multiple Topics

**Scenario**: Building a Drive → Gmail automation pipeline.

**Your workflow**:
1. Search broadly: `memory_search("Drive Gmail automation")`
2. If results are sparse, recall specific topics:
   - `memory_recall("drive-integration")`
   - `memory_recall("gmail-workflows")`
3. Synthesize patterns from both domains
4. Document new combined patterns in your response (they'll be captured for future use)

**Why**: Complex tasks often span multiple knowledge domains.

---

## Understanding Provenance

When `memory_search` returns results, each entry has a `source` field (VFS path with fragment):

- `/Documents/Memory/Topics/gmail-workflows.md#entry-3` - From a topic file (consolidated knowledge)
- `/Documents/Memory/Episodes/2026-07-05-abc123.md#lessons` - From an episode (recent, not yet consolidated)

**Interpretation**:
- **Topic sources** = Durable, cross-conversation lessons (high confidence)
- **Episode sources** = Recent discoveries, may be refined later (medium confidence)

Use this to prioritize: topic entries are more likely to be reliable; episode entries might contain tentative observations.

---

## What Gets Saved vs What Doesn't

### Automatically Saved (via Memory Loops)

The fast loop and slow loop automatically capture:
- **Corrections** you received ("that's wrong, it should be X")
- **Lessons** from successful/unsuccessful approaches
- **Patterns** that recur across conversations
- **Profile suggestions** (observed user preferences, not confirmed identity)

### NOT Automatically Saved

The loops deliberately ignore:
- **Transient failures** (network hiccups that resolved themselves)
- **One-off narratives** (unique circumstances not generalizable)
- **Negative tool claims** ("I can't do X" when it later worked)
- **Simple preferences** (unless they recur frequently enough to be a pattern)

### Manual Save (via `memory_save`)

You can still use `memory_save` for:
- **Identity facts** about the user (goes to USER.md) - requires explicit confirmation
- **Global lessons** that don't fit a specific topic (goes to MEMORY.md)
- **Urgent corrections** you want in memory immediately (don't wait for consolidation)

---

## Topic Organization

Topics are organized by domain/task-class. Common topics include:

| Topic Slug | Description |
|------------|-------------|
| `gmail-workflows` | Gmail API patterns, OAuth scopes, label operations |
| `drive-integration` | Drive file monitoring, search patterns, collision handling |
| `scheduler-jobs` | Scheduler job patterns, cron syntax, error handling |
| `mcp-servers` | MCP tool usage, connection patterns, server configuration |
| `memory-system` | Memory loop behavior, episode consolidation, topic sharding |

**New topics are created automatically** when the slow loop consolidates lessons that don't fit existing topics.

---

## Example Conversation Flow

**User**: "I need to set up a scheduled task that monitors my Drive folder and sends Gmail notifications when new files arrive."

**You**: 
1. `memory_search("Drive folder monitoring Gmail notification")`
   - Returns: Drive file search patterns, Gmail send message patterns
   
2. `memory_recall("drive-integration")`
   - Returns: "Use `modifiedTime` filter instead of folder polling for efficiency"
   
3. `memory_recall("gmail-workflows")`
   - Returns: "Gmail send requires `gmail.send` scope", "Template messages for notifications"

4. Implement the solution, applying these patterns

5. During implementation, user corrects you: "Actually, I need to check file types, not just monitor all files"

6. You capture this correction; it goes into the current episode

7. Later, the slow loop consolidates this into `drive-integration` topic:
   - "- [2026-07-08] Drive monitoring can filter by mimeType (e.g., `mimeType='application/pdf'`) to check file types"

**Next time**: Someone asks the same question, you'll have this lesson ready.

---

## Tips for Effective Memory Use

1. **Search early**: Before starting complex tasks, search for existing patterns
2. **Recall specific topics**: If you know the domain, recall the topic directly (faster than search)
3. **Trust topic entries more**: They've been consolidated from multiple conversations
4. **Treat episode entries as tentative**: They're recent and might be refined
5. **Speak up if something's wrong**: Corrections get captured in episodes → consolidated to topics

---

## Troubleshooting

### "memory_search returned nothing"
- Try a broader query (fewer keywords)
- Check if the topic exists: `memory_recall()` to see the global index
- The knowledge might not exist yet; your current conversation will create it

### "memory_recall(topic) says topic not found"
- Check the topic slug spelling (lowercase, kebab-case)
- List available topics: search for files in `/Documents/Memory/Topics/`
- The topic might not have been created yet; lessons about this topic are still in episodes

### "I'm seeing duplicate or contradictory entries"
- This can happen during consolidation; the slow loop should supersede old entries
- If you see actual duplicates, flag it; it's a bug in the consolidation logic
- Contradictions with timestamps: newer entry supersedes older one

---

## Advanced: Understanding the Memory Loop Pipeline

If you're curious about how memory works under the hood:

1. **Fast Loop** (every 2 min): Reviews idle conversations → writes episodes
2. **Slow Loop** (hourly): Consolidates episodes → updates topics + patches/creates skills
3. **Episode**: Short-term buffer (`/Documents/Memory/Episodes/<date>-<convId>.md`)
4. **Topic**: Long-term storage (`/Documents/Memory/Topics/<slug>.md`)
5. **Watermark**: Tracks which messages have been reviewed (in `/Documents/Memory/.watermarks.json`)

Both loops are `system` JobDefinitions in the Unified Job Engine, seeded into `/Documents/System/scheduler-jobs.json` on boot via `ensureSystemJob(...)`.

You don't need to interact with these directly—use `memory_search` and `memory_recall`. But knowing the pipeline helps you understand why lessons might take an hour to appear in topics (they're waiting for consolidation).
