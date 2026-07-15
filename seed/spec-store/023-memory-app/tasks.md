# Implementation Tasks: Memory App Redesign

**Feature**: `023-memory-app`  
**Branch**: `bos/023-memory-app`  
**Generated**: 2026-07-05

---

## Critical Note

This task list is for **replacing** the existing Memory app at `src/apps/memory/`. Do not migrate old code; rewrite everything according to this spec. Only preserve the functionality (USER.md/MEMORY.md management), not the implementation.

---

## Phase 1: Backend API Verification & Completion

### Task 1.1: Verify Spec 021 Implementation
- [ ] Check `/Documents/Memory/Episodes/` directory exists with sample files
- [ ] Verify `/Documents/Memory/Topics/` directory exists with topic files
- [ ] Confirm `/Documents/Memory/.watermarks.json` exists
- [ ] Validate scheduler jobs in `/Documents/System/scheduler-jobs.json` for `system:memory.fast-loop` and `system:memory.slow-loop`
- **Output**: Report on which components are implemented vs. missing

### Task 1.2: Backend API Audit
- [ ] Test `GET /api/memory?target=user` returns USER.md entries
- [ ] Test `GET /api/memory?target=memory` returns MEMORY.md entries
- [ ] Test `POST /api/memory` with add/replace/remove actions
- [ ] Test `GET /api/memory/search?q=test` returns search results
- [ ] Test `POST /api/memory/consolidate` triggers slow loop
- [ ] Test `POST /api/assistant/reflect` with conversationId triggers fast loop
- [ ] Test `GET /api/config?namespace=memoryLoops` returns configuration
- **Output**: List of working endpoints vs. missing/broken

### Task 1.3: Identify Backend Gaps
- [ ] Document missing episode endpoints (list, get, delete)
- [ ] Document missing topic management endpoints
- [ ] Identify required changes to `src/lib/agent/memory/` services
- [ ] Create prioritized list of backend tasks
- **Output**: Gap analysis document with implementation priorities

### Task 1.4: Episode Service Implementation
**File**: `src/lib/agent/memory/episodes.ts` (create if missing)

```typescript
export interface EpisodeMeta {
  filename: string;
  conversationId: string;
  createdAt: string;
  updatedAt: string;
  watermark: string;
  skillsUsed: string[];
  status: 'pending' | 'consolidated';
  skillCandidates?: string[];
  turnCount: number;
}

export interface Episode extends EpisodeMeta {
  title: string;
  sections: {
    taskOutcome: string;
    whatWorked: string;
    whatFailed: string;
    correctionsReceived: string;
    durableLessonCandidates: string;
    profileSuggestions: string;
  };
}

export async function listEpisodes(): Promise<{ pending: EpisodeMeta[]; consolidated: EpisodeMeta[] }>;
export async function getEpisode(filename: string): Promise<Episode | null>;
export async function deleteEpisode(filename: string): Promise<void>;
export async function archiveEpisode(filename: string): Promise<void>;
```

**Requirements**:
- Scan `/Documents/Memory/Episodes/` for `.md` files
- Parse frontmatter for metadata
- Parse markdown sections for content
- Atomic reads with error handling
- Handle `.Archive/` subdirectory

### Task 1.5: Episode API Routes
**Files**: 
- `src/pages/api/memory/episodes.ts` (GET - list)
- `src/pages/api/memory/episodes/[filename].ts` (GET - single, DELETE)

**Requirements**:
- Validate filename format (prevent path traversal)
- Return proper error codes (404, 500)
- Log delete operations

### Task 1.6: Topic Service Extensions
**File**: `src/lib/agent/memory/topics.ts` (extend existing)

```typescript
export async function addTopicEntry(slug: string, content: string): Promise<number>;
export async function replaceTopicEntry(slug: string, id: number, content: string): Promise<void>;
export async function deleteTopicEntry(slug: string, id: number): Promise<void>;
export async function getTopicBudget(slug: string): Promise<{ used: number; max: number }>;
```

**Requirements**:
- Enforce 4000 char budget per topic
- Incremental operations only (no full rewrites)
- Atomic writes with temp file + rename

### Task 1.7: Topic API Extensions
**File**: `src/pages/api/memory.ts` (extend existing POST/DELETE handlers)

**Requirements**:
- Handle `target: "topic"` for add/replace/remove actions
- Budget validation on add
- Proper error responses

### Task 1.8: Configuration Validation
**File**: `src/lib/config/registry.ts` (verify memoryLoops namespace)

**Requirements**:
- Add validation rules (min/max values)
- Ensure defaults match spec (120s, 300s, 40 turns, etc.)

### Task 1.9: Run History Endpoint
**File**: `src/pages/api/logs.ts` (extend or create)

**Requirements**:
- Query central logging system
- Aggregate loop execution data
- Return formatted history entries

### Task 1.10: Backend Testing
- [ ] Write unit tests for episode service functions
- [ ] Write unit tests for topic service extensions
- [ ] Write integration tests for all new API routes
- [ ] Test edge cases (missing files, invalid IDs, budget overflows)
- [ ] Run `npx tsc --noEmit` and fix errors
- [ ] Run `npm run lint` and fix warnings

---

## Phase 2: App Replacement

### Task 2.1: Backup Existing Code
- [ ] Copy `src/apps/memory/` to `src/apps/memory-backup/` (reference only)
- [ ] Document what functionality exists in the old app

### Task 2.2: Update App Manifest
**File**: `src/apps/memory/manifest.ts` (replace entirely)

```typescript
import type { AppManifest } from "@/os/types";

const manifest: AppManifest = {
  id: "memory",
  name: "Memory",
  icon: "Brain", // Ensure this exists in src/components/desktop/icons.tsx
  defaultWidth: 1200,
  defaultHeight: 800,
  order: 40,
  singleton: true,
  builtin: true,
};

export default manifest;
```

**Requirements**:
- Verify "Brain" icon exists in `src/components/desktop/icons.tsx`
- If not, add it to the icons map

### Task 2.3: Create New Main Component
**File**: `src/apps/memory/index.tsx` (replace entirely)

**Requirements**:
- Implement 5-tab structure with proper state management
- Use BOS Style Guide patterns (opacity colors, text-xs, lucide-react)
- Ensure `min-h-0 flex-1` on scroll regions
- Load stats from API on mount

### Task 2.4: Create Tab Component Stubs
**Files**:
- `src/apps/memory/components/ProfileTab.tsx` (stub)
- `src/apps/memory/components/EpisodesTab.tsx` (stub)
- `src/apps/memory/components/TopicsTab.tsx` (stub)
- `src/apps/memory/components/LoopsTab.tsx` (stub)
- `src/apps/memory/components/SearchTab.tsx` (stub)

**Requirements**:
- Export default function component for each
- Return placeholder div with "TODO: Implement {TabName}"
- Use proper TypeScript typing
- Ensure all imports resolve

### Task 2.5: Verify App Launches
- [ ] Start dev server: `npm run dev`
- [ ] Launch Memory app from dock
- [ ] Verify all 5 tabs are visible and clickable
- [ ] Confirm active tab state changes correctly
- [ ] Check browser console for errors

---

## Phase 3: Profile & Notes Tab

### Task 3.1: Implement Two-Pane Layout
**File**: `src/apps/memory/components/ProfileTab.tsx`

**Requirements**:
- Create two-pane layout (User Profile left, Agent Notes right)
- Add "Add" button for each pane
- Display entries in scrollable list
- Add budget bars at bottom of each pane

### Task 3.2: Data Loading
```typescript
const [userEntries, setUserEntries] = useState<string[]>([]);
const [memoryEntries, setMemoryEntries] = useState<string[]>([]);
const [loading, setLoading] = useState(true);

useEffect(() => {
  const load = async () => {
    const [userRes, memoryRes] = await Promise.all([
      fetch("/api/memory?target=user"),
      fetch("/api/memory?target=memory")
    ]);
    setUserEntries((await userRes.json()).entries);
    setMemoryEntries((await memoryRes.json()).entries);
    setLoading(false);
  };
  load();
}, []);
```

### Task 3.3: Budget Display
- Implement `BudgetBar` component with color coding
- Green (<50%), Amber (50-80%), Red (>80%)
- Show current chars / max chars

### Task 3.4: Entry CRUD Operations
- [ ] Implement "Add" button with modal or inline input
- [ ] Connect to `POST /api/memory` with `target: "user"` or `target: "memory"`
- [ ] Implement delete with confirmation dialog
- [ ] Handle errors (budget overflow, validation failures)

### Task 3.5: Add Info Banner
```tsx
<div className="mt-2 rounded-lg border border-violet-400/20 bg-violet-400/10 p-2 text-xs text-white/90">
  <InfoIcon className="mr-1 inline h-3.5 w-3.5" />
  Changes take effect in your <strong>next conversation</strong>.
</div>
```

### Task 3.6: Test Profile Tab
- [ ] Add entries to both panes
- [ ] Delete entries
- [ ] Verify budget bars update correctly
- [ ] Check responsive behavior on small screens

---

## Phase 4: Episodes Tab

### Task 4.1: Implement Episodes List Component
**File**: `src/apps/memory/components/EpisodesTab.tsx`

**Requirements**:
- Create two-pane layout structure
- Add filter buttons (All/Pending/Consolidated)
- Fetch episodes from `/api/memory/episodes`
- Render episode list with metadata and badges
- Implement selection state

### Task 4.2: Implement Episode Details Component
**File**: `src/apps/memory/components/EpisodeDetail.tsx` (new file)

**Requirements**:
- Display episode metadata (status, conversationId, timestamps, skills)
- Render all six sections with proper formatting
- Add action buttons (Review, Archive, Delete)
- Implement Previous/Next navigation

### Task 4.3: Connect Episode Actions
- [ ] "Review Now" → `POST /api/assistant/reflect`
- [ ] "Archive" → Move to `.Archive/` (backend operation)
- [ ] "Delete" → `DELETE /api/memory/episodes/:filename` with confirmation

### Task 4.4: Test Episodes Tab
- [ ] Load episodes list
- [ ] Switch between filters
- [ ] View episode details
- [ ] Trigger review action
- [ ] Test archive/delete operations

---

## Phase 5: Topics Tab

### Task 5.1: Implement Topics List Component
**File**: `src/apps/memory/components/TopicsTab.tsx`

**Requirements**:
- Two-pane layout with search box
- Fetch topics from `/api/memory/topics`
- Render list with entry counts and budget bars
- Implement selection state

### Task 5.2: Implement Topic Details Component
**File**: `src/apps/memory/components/TopicDetail.tsx` (new file)

**Requirements**:
- Display numbered entries with content
- Show timestamps and consolidation source
- Add "Add Entry" and "Delete Topic" buttons

### Task 5.3: Connect Topic Operations
- [ ] "Add Entry" → Modal with textarea, `POST /api/memory` with `target: "topic"`
- [ ] "Delete Entry" → `DELETE /api/memory?target=topic&topic=<slug>&id=<number>`
- [ ] Budget validation on add

### Task 5.4: Test Topics Tab
- [ ] Load topics list
- [ ] Search/filter topics
- [ ] Add new entries
- [ ] Delete entries and topics

---

## Phase 6: Memory Loops Tab

### Task 6.1: Implement Configuration Form
**File**: `src/apps/memory/components/LoopsTab.tsx`

**Requirements**:
- Create Fast Loop section with toggle, inputs, dropdowns
- Create Slow Loop section (same pattern)
- Create Advanced Settings section
- Fetch config from `/api/config?namespace=memoryLoops`

### Task 6.2: Implement Run History Component
**File**: `src/apps/memory/components/RunHistory.tsx` (new file)

**Requirements**:
- Fetch history from `/api/logs?category=memory.loops`
- Display last execution summaries
- Add manual trigger buttons with loading states

### Task 6.3: Connect Configuration Operations
- [ ] "Save" → `POST /api/config` with namespace and values
- [ ] "Reset" → Restore defaults
- [ ] Manual triggers → `POST /api/memory/consolidate` and `POST /api/assistant/reflect`

### Task 6.4: Test Loops Tab
- [ ] Load configuration
- [ ] Modify settings and save
- [ ] Trigger loops manually
- [ ] Verify run history updates

---

## Phase 7: Search Tab

### Task 7.1: Implement Search Interface
**File**: `src/apps/memory/components/SearchTab.tsx`

**Requirements**:
- Search box with Enter key support and debounce
- Source filter buttons (All/Topics/Episodes/Memory)
- Results count display

### Task 7.2: Implement Results Display
**File**: `src/apps/memory/components/SearchResults.tsx` (new file)

**Requirements**:
- Fetch from `/api/memory/search?q=<query>&maxResults=50`
- Render results with source, content, score
- Highlight matched terms
- Add "Load More" pagination

### Task 7.3: Test Search Tab
- [ ] Execute searches
- [ ] Apply filters
- [ ] Verify highlighting and scores
- [ ] Test pagination

---

## Phase 8: Polish & Testing

### Task 8.1: Responsive Design
- [ ] Add media queries for <768px screens
- [ ] Stack two-pane layouts to single column
- [ ] Adjust font sizes and spacing

### Task 8.2: Loading & Error States
- [ ] Add loading spinners for all async operations
- [ ] Display error messages with retry options
- [ ] Handle empty states gracefully

### Task 8.3: Accessibility Audit
- [ ] Add ARIA labels to all interactive elements
- [ ] Test keyboard navigation (Tab, Enter, Escape)
- [ ] Verify focus states on all controls
- [ ] Run Lighthouse audit (target >90)

### Task 8.4: TypeScript & Lint
- [ ] Run `npx tsc --noEmit` and fix all errors
- [ ] Run `npm run lint` and fix all warnings
- [ ] Add missing type definitions

### Task 8.5: Documentation
- [ ] Update `docs/usage/apps/memory.md` with new features
- [ ] Update `docs/dev/memory/memory.md` with API changes
- [ ] Add screenshots if applicable

### Task 8.6: Final Testing
- [ ] Test all user stories from spec
- [ ] Verify backward compatibility
- [ ] Performance test with large datasets
- [ ] Cross-browser testing (Chrome, Firefox, Safari)

---

## Completion Criteria

All tasks must be completed and verified:
- [ ] All Phase 1-8 tasks checked off
- [ ] `npx tsc --noEmit` passes with no errors
- [ ] `npm run lint` passes with no warnings
- [ ] All user stories from spec work as expected
- [ ] Documentation updated
- [ ] Old Memory app code completely replaced
- [ ] Feature branch ready for merge

---

## Notes for Developer

- **Follow BOS Style Guide strictly**: opacity colors, text-xs default, lucide-react icons
- **Use mockup as reference**: `/mockups/memory-app-redesign.html` is the normative UI reference
- **No code migration**: Completely rewrite the app; do not try to preserve old code
- **Implement loading states**: All async operations need proper loading/error handling
- **Keep components small**: Extract shared logic into utilities
- **Write meaningful commits**: Describe what changed and why
- **Test incrementally**: After each phase, verify functionality before moving on
