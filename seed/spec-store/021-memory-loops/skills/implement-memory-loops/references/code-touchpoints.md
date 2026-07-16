# Code Touchpoints: Memory Loops Implementation

This document provides per-file design detail for implementing spec 021-memory-loops. Use this alongside `SKILL.md` and the main spec/tasks files.

---

## Episode Store (`src/lib/agent/memory/episodes.ts`)

### File Path Pattern
```typescript
// All paths are VFS paths under /Documents/Memory/
const EPISODES_DIR = '/Documents/Memory/Episodes';
const ARCHIVE_DIR = '/Documents/Memory/Episodes/.Archive';

function episodePath(conversationId: string): string {
  const date = new Date().toISOString().split('T')[0]; // yyyy-mm-dd
  return `${EPISODES_DIR}/${date}-${conversationId}.md`;
}
```

### Frontmatter Format
```yaml
---
conversationId: abc123-def456
createdAt: 2026-07-05T14:30:00Z
updatedAt: 2026-07-05T14:35:00Z
watermark: msg_789xyz
skillsUsed:
  - gmail-workflows
  - memory_search
status: pending
skillCandidates:
  - drive-gmail-integration
---
```

### Body Format (Markdown)
```markdown
## Task & Outcome

User wanted to automate Gmail labeling based on Drive file uploads. Successfully implemented using scheduler + webhook pattern.

## What Worked / What Failed

**Worked:**
- Using `drive_folders_list` to monitor specific folder
- Scheduler job triggered on new file detection
- Gmail label applied via `gmail_messages_modify`

**Failed:**
- Initial attempt used polling every 5 min (too slow)
- Webhook approach required CORS config (documented in corrections)

## Corrections Received

- User corrected: "Actually, use `drive_files_search` with `modifiedTime` filter instead of folder listing"
- Misunderstanding clarified: "Labels should be added to sender's emails, not all emails"

## Durable Lesson Candidates

- Drive file monitoring is more efficient with `modifiedTime` search than folder polling
- Gmail label operations require `gmail.modify` scope (not just `gmail.readonly`)
- CORS preflight fails for webhooks; use scheduler polling as fallback

## Profile Suggestions

- User frequently works with Drive → Gmail automation patterns
- User prefers TypeScript implementations over JavaScript
- User has multiple Gmail accounts (needs multi-account support)
```

### Atomic Write Pattern
```typescript
import { writeTempFile, atomicRename } from '../memory/curated.ts'; // Reuse existing utils

async function createEpisode(conversationId: string): Promise<Episode> {
  const episode: Episode = {
    conversationId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    watermark: '',
    skillsUsed: [],
    status: 'pending',
    skillCandidates: []
  };
  
  const content = formatEpisodeMarkdown(episode);
  
  // Injection scan BEFORE writing
  if (looksLikeInjection(content)) {
    throw new Error('Episode content failed injection scan');
  }
  
  const tempPath = await writeTempFile(EPISODES_DIR, content);
  const finalPath = episodePath(conversationId);
  await atomicRename(tempPath, finalPath);
  
  return episode;
}
```

### Idempotency Logic
```typescript
async function updateEpisode(conversationId: string, updates: Partial<EpisodeBody>): Promise<Episode> {
  const path = episodePath(conversationId);
  
  // Check if episode exists for TODAY
  let episode = await getEpisode(conversationId);
  if (!episode) {
    episode = await createEpisode(conversationId);
  }
  
  // Merge updates into existing sections
  episode.taskOutcome = mergeSections(episode.taskOutcome, updates.taskOutcome);
  episode.whatWorked = [...(episode.whatWorked || []), ...(updates.whatWorked || [])];
  // ... etc for other sections
  
  episode.updatedAt = new Date().toISOString();
  
  const content = formatEpisodeMarkdown(episode);
  if (looksLikeInjection(content)) {
    throw new Error('Updated episode content failed injection scan');
  }
  
  await atomicWrite(path, content); // temp + rename
  return episode;
}
```

---

## Watermarks (`src/lib/agent/memory/watermarks.ts`)

### File Structure
```typescript
// /Documents/Memory/.watermarks.json (VFS)
{
  "abc123-def456": {
    "messageId": "msg_789xyz",
    "reviewedAt": "2026-07-05T14:35:00Z"
  },
  "ghi789-jkl012": {
    "messageId": "msg_456abc",
    "reviewedAt": "2026-07-05T12:00:00Z"
  }
}
```

### Validation on Startup
```typescript
async function validateWatermarks(): Promise<void> {
  const watermarks = await loadWatermarkStore();
  
  for (const [convId, wm] of Object.entries(watermarks)) {
    const convPath = `/Documents/Chats/${convId}.json`;
    const conversation = await readVfsFile(convPath);
    
    if (!conversation || !conversation.messages) continue;
    
    const maxMessageId = conversation.messages[conversation.messages.length - 1].id;
    
    // If watermark points to non-existent message, reset to last valid
    if (!conversation.messages.find(m => m.id === wm.messageId)) {
      // Find closest valid message before watermark
      const validIndex = conversation.messages.findIndex(m => m.id === maxMessageId);
      watermarks[convId].messageId = conversation.messages[validIndex]?.id || '';
      watermarks[convId].reviewedAt = new Date().toISOString();
    }
  }
  
  await saveWatermarkStore(watermarks);
}
```

---

## Fast Loop (`src/lib/agent/memory/fast-loop.ts`)

### Eligibility Check Logic
```typescript
interface ConversationRef {
  id: string;
  path: string;
  messages: Message[];
  lastModified: Date;
}

async function scanEligibleConversations(): Promise<ConversationRef[]> {
  const chatsDir = '/Documents/Chats';
  const files = await listVfsDirectory(chatsDir);
  
  const eligible: ConversationRef[] = [];
  
  for (const file of files.filter(f => f.name.endsWith('.json'))) {
    const convId = file.name.replace('.json', '');
    const conversation = await readVfsFile(`${chatsDir}/${file.name}`);
    const watermark = await getWatermark(convId);
    
    // Find messages after watermark
    const newMessages = conversation.messages.filter(m => 
      !watermark || m.index > watermark.index
    );
    
    // Skip if < 4 new turns (debounce)
    if (newMessages.length < 4) continue;
    
    // Check idle threshold OR turn cap OR conversation closed
    const idleTime = Date.now() - conversation.lastModified;
    const unreviewedTurns = newMessages.filter(m => m.role === 'assistant').length;
    
    const isIdle = idleTime >= config.fastLoop.idleThreshold;
    const hitsCap = unreviewedTurns >= config.fastLoop.turnCap;
    const isClosed = conversation.status === 'closed'; // or no recent activity
    
    if (isIdle || hitsCap || isClosed) {
      eligible.push({ id: convId, path: file.path, messages: newMessages, lastModified: conversation.lastModified });
    }
  }
  
  return eligible;
}
```

### LLM Call with Restricted Toolset
```typescript
const FAST_LOOP_TOOLS = [
  { name: 'episode_write', schema: EpisodeWriteSchema },
  { name: 'skill_patch', schema: SkillPatchSchema }
  // NOTE: NO skill_create, memory_add_entry, topic_create, etc.
];

async function reviewConversation(convRef: ConversationRef): Promise<EpisodeUpdate> {
  const transcriptSlice = formatTranscript(convRef.messages);
  const existingEpisode = await getEpisode(convRef.id);
  
  const result = await callLLM({
    system: FAST_LOOP_SYSTEM_PROMPT,
    user: `Review these new turns:\n\n${transcriptSlice}\n\nExisting episode context:\n${existingEpisode ? formatEpisode(existingEpisode) : 'No existing episode'}`,
    tools: FAST_LOOP_TOOLS,
    model: config.modelOverride || 'default-fast-loop-model'
  });
  
  // Extract skillsUsed from telemetry (mechanical capture)
  const skillsUsed = extractSkillsFromToolCalls(result.toolCalls);
  
  return {
    updates: result.episodeUpdates,
    skillsUsed,
    watermark: convRef.messages[convRef.messages.length - 1].id
  };
}
```

---

## Topics (`src/lib/agent/memory/topics.ts`)

### Entry Format (Same as MEMORY.md)
```markdown
## Topic: gmail-workflows

- [2026-07-05] Gmail API requires OAuth scope `https://www.googleapis.com/auth/gmail.modify` for label operations. Readonly scope insufficient.
- [2026-07-06] Use `gmail_messages_search` with `q: "label:UNREAD"` instead of listing all messages (performance).
```

### Budget Enforcement
```typescript
const TOPIC_BUDGET = 4000; // chars (configurable)

async function addTopicEntry(topicSlug: string, entry: string): Promise<void> {
  const topic = await getOrCreateTopic(topicSlug);
  
  const newContent = `${topic.body}\n- [${new Date().toISOString()}] ${entry}`;
  
  if (newContent.length > TOPIC_BUDGET) {
    // Suggest creating new shard
    const shardNum = await findNextShardNumber(topicSlug);
    throw new TopicBudgetExceededError(
      `Topic "${topicSlug}" at budget limit. Create "${topicSlug}-${shardNum}" instead.`
    );
  }
  
  topic.body = newContent;
  await atomicWrite(topicPath(topicSlug), formatTopicMarkdown(topic));
}
```

### Supersession Semantics
```typescript
async function replaceTopicEntry(topicSlug: string, entryId: string, newContent: string): Promise<void> {
  const topic = await getTopic(topicSlug);
  
  // Find entry by ID (first line after "## Topic:" that contains the ID)
  const entryIndex = topic.entries.findIndex(e => e.id === entryId);
  
  if (entryIndex === -1) {
    throw new EntryNotFoundError(`Entry ${entryId} not found in topic ${topicSlug}`);
  }
  
  // Mark old entry as superseded
  const oldEntry = topic.entries[entryIndex];
  oldEntry.content += ` [SUPERSEDED by ${entryId}-${new Date().toISOString()}]`;
  
  // Add new entry with same ID (effectively replacing)
  topic.entries[entryIndex] = {
    ...oldEntry,
    content: newContent,
    supersededAt: null // Clear supersession flag for new version
  };
  
  await atomicWrite(topicPath(topicSlug), formatTopicMarkdown(topic));
}
```

---

## Consolidation (`src/lib/agent/memory/consolidate.ts`)

### Lock File Handling
```typescript
const LOCK_FILE = '/Documents/Memory/.consolidate.lock'; // VFS
const STALENESS_EXPIRY_MS = 30 * 60 * 1000; // 30 min

interface Lock {
  pid: number;
  startedAt: string;
  batchId: string;
}

async function acquireLock(): Promise<Lock | null> {
  const now = Date.now();
  
  // Check if lock exists
  try {
    const lockContent = await readVfsFile(LOCK_FILE);
    const lock: Lock = JSON.parse(lockContent);
    
    const age = now - new Date(lock.startedAt).getTime();
    if (age < STALENESS_EXPIRY_MS) {
      return null; // Lock held by another process
    }
    // Lock is stale; will overwrite
  } catch (e) {
    // No lock file exists; proceed
  }
  
  // Create new lock
  const lock: Lock = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    batchId: `consolidate-${Date.now()}`
  };
  
  await atomicWrite(LOCK_FILE, JSON.stringify(lock, null, 2));
  return lock;
}

async function releaseLock(lock: Lock): Promise<void> {
  // Delete lock file (or set status = complete)
  await deleteVfsFile(LOCK_FILE);
}
```

### Skill Creation Gate Validation
```typescript
async function validateSkillCreationGate(taskClass: string, episodeContext: Episode): Promise<boolean> {
  // Condition 1: No existing skill
  const allSkills = await skill_list();
  const matchingSkill = allSkills.find(s => 
    s.name.toLowerCase().includes(taskClass.toLowerCase()) ||
    s.description?.toLowerCase().includes(taskClass.toLowerCase())
  );
  
  if (matchingSkill) {
    console.log(`Skill "${taskClass}" already exists as "${matchingSkill.id}"; use skill_patch instead`);
    return false;
  }
  
  // Condition 2: Complexity threshold
  const isComplex = assessComplexity(episodeContext);
  if (!isComplex) {
    console.log(`Task "${taskClass}" does not meet complexity threshold`);
    return false;
  }
  
  // Condition 3: Recurrence evidence
  const recurrenceCount = await searchSkillCandidates(taskClass);
  if (recurrenceCount < 2) {
    console.log(`Task "${taskClass}" has only ${recurrenceCount} occurrence(s); need ≥2`);
    return false;
  }
  
  return true; // All conditions met
}

function assessComplexity(episode: Episode): boolean {
  // Heuristics for complexity:
  // - Multiple steps mentioned in taskOutcome
  // - Non-obvious ordering (e.g., "must do X before Y")
  // - Discovered pitfalls listed in whatFailed
  
  const stepCount = (episode.taskOutcome?.match(/\d+\./g) || []).length;
  const hasOrdering = episode.taskOutcome?.toLowerCase().includes('before') || 
                      episode.taskOutcome?.toLowerCase().includes('then');
  const hasPitfalls = episode.whatFailed?.length > 0;
  
  return stepCount >= 3 || (hasOrdering && hasPitfalls);
}

async function searchSkillCandidates(taskClass: string): Promise<number> {
  // Search all episodes for matching skill-candidate tags
  const episodesDir = '/Documents/Memory/Episodes';
  const files = await listVfsDirectory(episodesDir);
  
  let count = 0;
  for (const file of files.filter(f => f.name.endsWith('.md') && !f.name.startsWith('.'))) {
    const content = await readVfsFile(`${episodesDir}/${file.name}`);
    if (content.includes(`skillCandidates:\n  - ${taskClass}`) || 
        content.includes(`- ${taskClass}`)) {
      count++;
    }
  }
  
  return count;
}
```

---

## Search (`src/lib/agent/memory/search.ts`)

### Substring Match Implementation
```typescript
interface SearchResult {
  source: string;      // e.g., "/Documents/Memory/Topics/gmail-workflows.md#entry-3"
  content: string;
  score: number;
}

async function memory_search(query: string, maxResults = 10): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  
  // Search topics
  const topicsDir = '/Documents/Memory/Topics';
  const topicFiles = await listVfsDirectory(topicsDir);
  
  for (const file of topicFiles.filter(f => f.name.endsWith('.md'))) {
    const content = await readVfsFile(`${topicsDir}/${file.name}`);
    const topicSlug = file.name.replace('.md', '');
    
    const entries = parseTopicEntries(content);
    for (const [index, entry] of entries.entries()) {
      const matchScore = scoreMatch(entry.content, queryWords);
      if (matchScore > 0) {
        results.push({
          source: `${topicsDir}/${topicSlug}.md#entry-${index + 1}`,
          content: entry.content,
          score: matchScore
        });
      }
    }
  }
  
  // Search episodes (pending + recent consolidated)
  const episodesDir = '/Documents/Memory/Episodes';
  const episodeFiles = await listVfsDirectory(episodesDir);
  
  for (const file of episodeFiles.filter(f => f.name.endsWith('.md') && !f.name.startsWith('.'))) {
    const content = await readVfsFile(`${episodesDir}/${file.name}`);
    
    // Only search durable lessons section
    const lessonsMatch = content.match(/## Durable Lesson Candidates\n([\s\S]*?)(?=\n##|$)/);
    if (lessonsMatch) {
      const lessons = lessonsMatch[1];
      const matchScore = scoreMatch(lessons, queryWords);
      if (matchScore > 0) {
        results.push({
          source: `${episodesDir}/${file.name}#lessons`,
          content: lessons.trim(),
          score: matchScore
        });
      }
    }
  }
  
  // Rank by score and limit
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

function scoreMatch(text: string, queryWords: string[]): number {
  const lowerText = text.toLowerCase();
  let score = 0;
  
  for (const word of queryWords) {
    if (lowerText.includes(word)) {
      score += 1;
      // Bonus for exact word match
      if (new RegExp(`\\b${word}\\b`).test(lowerText)) {
        score += 0.5;
      }
    }
  }
  
  return score;
}
```

---

## Integration Points

### Scheduler Seeding (Unified Job Engine)

Memory loops do **not** ship as standalone job files under `src/lib/integrations/scheduler/jobs/`. The Unified Job Engine (`src/lib/scheduler/engine.ts`, Phase 0 prerequisite) owns tick, persistence, failure isolation, and history. Memory loops just register internal handlers and seed JobDefinitions.

```typescript
// src/lib/agent/memory/fast-loop.ts
import { registerHandler, ensureSystemJob, type JobDefinition } from '@/lib/scheduler/engine';

export async function runFastLoop(): Promise<void> {
  // eligibility scan + LLM call + episode write ...
}

registerHandler('memory.fast-loop', runFastLoop);

export async function seedFastLoopJob(): Promise<void> {
  const def: JobDefinition = {
    id: 'system:memory.fast-loop',
    category: 'system',
    owner: 'memory',
    handler: { kind: 'internal', ref: 'memory.fast-loop' },
    scheduleType: 'recurring',
    scheduleConfig: { interval: 2, unit: 'minute' },
    readOnlyFields: ['handler', 'category'],
  };
  await ensureSystemJob(def); // idempotent: no-op if already seeded, preserves user edits
}
```

```typescript
// src/lib/agent/memory/consolidate.ts
import { registerHandler, ensureSystemJob, type JobDefinition } from '@/lib/scheduler/engine';

export async function runSlowLoop(): Promise<void> {
  // exit early if no pending episodes; respect /Documents/Memory/.consolidate.lock ...
}

registerHandler('memory.slow-loop', runSlowLoop);

export async function seedSlowLoopJob(): Promise<void> {
  const def: JobDefinition = {
    id: 'system:memory.slow-loop',
    category: 'system',
    owner: 'memory',
    handler: { kind: 'internal', ref: 'memory.slow-loop' },
    scheduleType: 'recurring',
    scheduleConfig: { interval: 1, unit: 'hour' },
    readOnlyFields: ['handler', 'category'],
  };
  await ensureSystemJob(def);
}
```

Both `seed*Job()` calls run on boot; both JobDefinitions land in `/Documents/System/scheduler-jobs.json`. Run history is appended by the engine to `/Documents/System/scheduler-history/system:memory.<fast|slow>-loop.jsonl`. **Do NOT** create `src/lib/integrations/scheduler/jobs/memory-*.ts` — the unified store is the only persistence.

### Config Registry
```typescript
// src/lib/config/registry.ts
registerNamespace('memoryLoops', {
  fastLoop: {
    enabled: { type: 'boolean', default: true },
    tickInterval: { type: 'number', default: 120 },
    idleThreshold: { type: 'number', default: 300 },
    turnCap: { type: 'number', default: 40 }
  },
  slowLoop: {
    enabled: { type: 'boolean', default: true },
    interval: { type: 'number', default: 3600 },
    batchSize: { type: 'number', default: 10 }
  },
  modelOverride: { type: 'string', optional: true },
  episodeArchiveAge: { type: 'number', default: 14 }
});
```

---

## Testing Patterns

### Mock LLM for Unit Tests
```typescript
// tests/memory/fast-loop.test.ts
const mockLLM = jest.fn().mockResolvedValue({
  toolCalls: [
    { name: 'episode_write', args: { taskOutcome: 'Test outcome' } }
  ],
  episodeUpdates: {
    taskOutcome: 'Test outcome',
    durableLessons: ['Lesson 1']
  }
});

// Inject mock into fast-loop module
jest.mock('../../../src/lib/agent/memory/fast-loop', () => ({
  ...jest.requireActual('../../../src/lib/agent/memory/fast-loop'),
  callLLM: mockLLM
}));
```

### Integration Test Setup
```typescript
// tests/memory-loops/fast-loop-integration.test.ts
beforeEach(async () => {
  // Create test conversation with 10 messages
  await createTestConversation('test-conv-1', 10);
  
  // Set watermark at message 3
  await setWatermark('test-conv-1', 'msg_3');
  
  // Advance file mtime to simulate idle time
  await touchFile(`/Documents/Chats/test-conv-1.json`, Date.now() - 400000); // ~7 min ago
});

it('produces episode within 2×tick interval', async () => {
  const startTime = Date.now();
  
  // Trigger fast loop (wait for next tick)
  await waitForFastLoopTick();
  
  // Check episode exists
  const episode = await getEpisode('test-conv-1');
  expect(episode).toBeDefined();
  expect(episode.status).toBe('pending');
  expect(Date.now() - startTime).toBeLessThan(2 * config.fastLoop.tickInterval * 1000);
});
```

---

## Debugging Tips

### Check Episode State
All memory artifacts live under the VFS at `/Documents/Memory/`. Inspect via the Files app, `vfs-read`/`vfs-list` tools, or `/api/fs`:
```bash
# List all episodes (via VFS API)
curl -s "http://localhost:3000/api/fs?op=list&path=/Documents/Memory/Episodes"

# View a single episode
curl -s "http://localhost:3000/api/fs?op=read&path=/Documents/Memory/Episodes/2026-07-05-abc123.md"

# Check watermarks
curl -s "http://localhost:3000/api/fs?op=read&path=/Documents/Memory/.watermarks.json"
```

### Manual Trigger for Testing
```typescript
// Via API
curl -X POST http://localhost:3000/api/assistant/reflect \
  -H "Content-Type: application/json" \
  -d '{"conversationId": "test-conv-1"}'

curl -X POST http://localhost:3000/api/memory/consolidate
```

### Log Inspection
```bash
# View recent consolidation runs (unified engine writes run-history per job)
curl -s "http://localhost:3000/api/fs?op=read&path=/Documents/System/scheduler-history/system:memory.slow-loop.jsonl" | tail -20

# Check for lock file (VFS)
curl -s "http://localhost:3000/api/fs?op=read&path=/Documents/Memory/.consolidate.lock" || echo "No lock file"

# Confirm memory jobs are seeded
curl -s "http://localhost:3000/api/fs?op=read&path=/Documents/System/scheduler-jobs.json" | jq '.[] | select(.owner == "memory")'
```
