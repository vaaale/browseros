# Feature Specification: Memory App Redesign

**Feature Branch**: `bos/023-memory-app`

**Created**: 2026-07-05

**Status**: Ready for Implementation

**Input**: "After implementing 021-memory-loops, the Memory app still uses the old two-surface model. Redesign to expose episodes, topics, loop configuration, and search capabilities."

> Extends `002-memory` (storage substrate) and `021-memory-loops` (automated loops). This spec **replaces** the existing Memory app UI (`src/apps/memory`) to expose the new episodic buffer, topic sharding, and automated loop management while maintaining backward compatibility with existing USER.md and MEMORY.md functionality.

---

## Problem Statement

After implementing spec **021-memory-loops**, the existing Memory app only displays the original two-surface model (USER.md + MEMORY.md). Users cannot:

1. View or manage **episodic memories** from automated fast loop reviews
2. Browse **topic-sharded long-term memory** files
3. Configure or monitor the **automated memory loops** (fast/slow)
4. Search across all memory surfaces with provenance

The existing app must be **completely replaced** with a new implementation that matches the new architecture while preserving backward compatibility.

---

## User Scenarios & Testing

### User Story 1 - View episodic memories (Priority: P1)

The user wants to see what the fast loop has captured from recent conversations, including pending episodes awaiting consolidation and consolidated episodes that have been merged into long-term memory.

**Acceptance Scenarios**:

1. **Given** episodes exist in `/Documents/Memory/Episodes/`, **When** the user opens the Episodes tab, **Then** they see a list with status badges (Pending/Consolidated), conversation IDs, timestamps, turn counts, and skills used.
2. **Given** a selected episode, **When** viewing details, **Then** all sections are displayed: Task & Outcome, What Worked, What Failed, Corrections Received, Durable Lesson Candidates, Profile Suggestions.
3. **Given** a pending episode, **When** the user clicks "Review Now", **Then** the fast loop is triggered for that conversation immediately (idle threshold waived).
4. **Given** an old consolidated episode (>14 days), **When** the user views it, **Then** they can archive or delete it with confirmation.

### User Story 2 - Browse topic-sharded memory (Priority: P1)

The user wants to explore long-term memory organized by topic, see entry counts and budget usage, and manage individual entries.

**Acceptance Scenarios**:

1. **Given** topic files exist in `/Documents/Memory/Topics/`, **When** the user opens the Topics tab, **Then** they see a list with topic names, entry counts, character budgets, and visual budget bars.
2. **Given** a selected topic, **When** viewing details, **Then** entries are displayed as numbered items with content, timestamps, and consolidation source information.
3. **Given** a topic with available budget, **When** the user adds an entry, **Then** it is appended with budget validation and timestamped.
4. **Given** conflicting entries, **When** replaced, **Then** the old entry is superseded (not duplicated) with timestamped provenance.

### User Story 3 - Configure memory loops (Priority: P1)

The user wants to control the automated fast and slow loop behavior, including intervals, thresholds, batch sizes, and model overrides.

**Acceptance Scenarios**:
1. **Given** the Memory Loops tab, **When** viewing configuration, **Then** all settings from the `memoryLoops` config namespace are displayed with current values (fast loop interval, idle threshold, turn cap; slow loop interval, batch size; archive age, topic budget).
2. **Given** a configuration change, **When** saved, **Then** it is persisted to Settings via the config API and takes effect on the next loop tick.
3. **Given** running loops, **When** viewing run history, **Then** last execution summaries show processed counts, created/updated items, and any refusals.
4. **Given** manual trigger buttons, **When** clicked, **Then** the respective loop runs immediately with status feedback.

### User Story 4 - Search across all surfaces (Priority: P2)

The user wants to find information across episodes, topics, USER.md, and MEMORY.md with relevance ranking and source provenance.

**Acceptance Scenarios**:
1. **Given** a search query, **When** executed, **Then** results include matches from all surfaces with file paths, entry locations (e.g., `#entry-3`), content snippets, and relevance scores.
2. **Given** filter options, **When** applied, **Then** results are restricted to selected sources (Topics/Episodes/Memory).
3. **Given** a result click, **When** activated, **Then** the UI navigates to the source location in the appropriate tab.

### User Story 5 - Maintain existing functionality (Priority: P1)

The user expects Profile & Notes tab to work exactly as before, with USER.md and MEMORY.md management, budget display, and "next conversation" warnings.

**Acceptance Scenarios**:
1. **Given** the Profile & Notes tab, **When** opened, **Then** it shows two panes: User Profile (USER.md) and Agent Notes (MEMORY.md) with existing add/edit/delete functionality.
2. **Given** budget usage, **When** displayed, **Then** visual bars show current chars / max chars with color coding (green/yellow/red).
3. **Given** mid-session edits, **When** made, **Then** a warning indicates changes take effect in the next conversation.

---

## Requirements

### Functional Requirements - UI Structure

- **FR-001**: The Memory app must have a **5-tab navigation** structure: Profile & Notes, Episodes, Topics, Memory Loops, Search.
- **FR-002**: Tabs must use the BOS standard tab pattern with icons from lucide-react and active state indication via `bg-white/15`.
- **FR-003**: The app root must be `flex h-full flex-col` with scroll regions using `min-h-0 flex-1 overflow-auto`.
- **FR-004**: All UI must follow the BOS Style Guide: opacity-based colors, text-xs default, lucide-react icons, canonical button/input recipes.
- **FR-005**: The existing Memory app (`src/apps/memory`) must be **completely replaced** with this new implementation; no migration path for old code.

### Functional Requirements - Profile & Notes Tab

- **FR-006**: Two-pane layout showing User Profile (left) and Agent Notes (right) with independent add/edit/delete controls.
- **FR-007**: Budget bars must display current usage vs. limits (1200 chars for USER.md, 2000 for MEMORY.md) with color-coded fill (green <50%, amber 50-80%, red >80%).
- **FR-008**: An info banner must warn that mid-session changes take effect in the next conversation.
- **FR-009**: The Agent Notes pane should display a count of linked topics for entries that index topic files.

### Functional Requirements - Episodes Tab

- **FR-010**: Two-pane layout with episode list (left) and details view (right).
- **FR-011**: Episode list must show: filename (date-conversationId), status badge (Pending/Consolidated), timestamp, turn count, skills used count.
- **FR-012**: Filter controls must allow toggling between All/Pending/Consolidated views.
- **FR-013**: Details view must display all episode metadata (conversationId, createdAt, updatedAt, watermark, skillsUsed, status, skillCandidates) and all body sections from spec 021 FR-001.
- **FR-014**: Action buttons must include "Review Now" (triggers fast loop), "Archive" (moves consolidated episodes >14 days to .Archive/), and "Delete" (with confirmation).
- **FR-015**: Navigation buttons must allow moving between adjacent episodes (Previous/Next).

### Functional Requirements - Topics Tab

- **FR-016**: Two-pane layout with topic list (left) and details view (right).
- **FR-017**: Topic list must show: topic name, entry count, character usage / budget (default 4000), visual budget bar.
- **FR-018**: Details view must display numbered entries with content, timestamps, and consolidation source (episode filename).
- **FR-019**: Actions must include "Add Entry" (with budget validation), "Delete Entry", and "Delete Topic" (with confirmation).
- **FR-020**: A search box must allow filtering topics by name.

### Functional Requirements - Memory Loops Tab

- **FR-021**: Configuration sections for Fast Loop, Slow Loop, and Advanced Settings with all fields from the `memoryLoops` config namespace (spec 021 FR-019).
- **FR-022**: Toggle switches must enable/disable each loop; numeric inputs for intervals/thresholds/batch sizes; dropdowns for model overrides.
- **FR-023**: A run history section must display last execution summaries for both loops, including: timestamp, processed counts, created/updated items, archived count, refusals.
- **FR-024**: Manual trigger buttons must invoke the respective loop immediately with visual feedback (loading state, success/error messages).
- **FR-025**: Save/Reset buttons must persist configuration to Settings API and restore defaults.

### Functional Requirements - Search Tab

- **FR-026**: A search box with query input and search button; optional debounce for performance.
- **FR-027**: Filter buttons to restrict results by source (All/Topics/Episodes/Memory).
- **FR-028**: Results must display: source path with location anchor, content snippet with matched terms highlighted, relevance score, timestamp/status.
- **FR-029**: Clicking a result must navigate to the source in the appropriate tab (implementation may be deferred to Phase 2).

### Functional Requirements - Backend Integration

- **FR-030**: The app must consume these API endpoints:
  - `GET /api/memory?target=user|memory` - load USER.md/MEMORY.md entries
  - `POST /api/memory` - add/replace/remove entries (user, memory, topic targets)
  - `GET /api/memory/episodes` - list episodes with metadata
  - `GET /api/memory/episodes/:filename` - get episode content
  - `DELETE /api/memory/episodes/:filename` - delete episode
  - `GET /api/memory/topics` - list topics with counts
  - `GET /api/memory?topic=<slug>` - get topic content
  - `GET /api/memory/search?q=<query>&maxResults=<n>` - search across all surfaces
  - `POST /api/memory/consolidate` - trigger slow loop
  - `POST /api/assistant/reflect` with `{ conversationId }` - trigger fast loop
  - `GET /api/config?namespace=memoryLoops` - load configuration
  - `POST /api/config` with `{ namespace: "memoryLoops", values: {...} }` - save configuration

- **FR-031**: If backend endpoints are missing, the app must display appropriate empty states or disabled controls with helpful messages.

### Functional Requirements - State Management

- **FR-032**: The app must use `useOSStore` selectors for OS state (window title, launch/close actions).
- **FR-033**: Dynamic data must be fetched in `useEffect` after mount to avoid client-only initial state.
- **FR-034**: Loading states must be shown during API calls; error states must display user-friendly messages.

### Non-Functional Requirements

- **NFR-001**: All components must be "use client" with no server-side initial state.
- **NFR-002**: No new UI dependencies; use only Tailwind CSS v4 and lucide-react.
- **NFR-003**: TypeScript strict mode compliance; `npx tsc --noEmit` must pass.
- **NFR-004**: ESLint clean; `npm run lint` must pass.
- **NFR-005**: Responsive design: two-pane layout stacks to single column on screens <900px wide.
- **NFR-006**: Accessibility: proper ARIA labels, keyboard navigation, focus states.

---

## Key Entities

### Episode Metadata
```typescript
interface EpisodeMeta {
  filename: string;           // e.g., "2026-07-05-c-mr8dczbxapny.md"
  conversationId: string;
  createdAt: string;          // ISO timestamp
  updatedAt: string;
  watermark: string;          // last reviewed message id
  skillsUsed: string[];       // skill IDs
  status: 'pending' | 'consolidated';
  skillCandidates?: string[]; // task class slugs
  turnCount: number;
}
```

### Topic Metadata
```typescript
interface TopicMeta {
  slug: string;               // e.g., "project-conventions"
  entryCount: number;
  charUsage: number;
  budget: number;             // default 4000
}
```

### Search Result
```typescript
interface SearchResult {
  source: string;             // e.g., "Topics/project-conventions.md#entry-1"
  content: string;            // snippet with matched terms
  score: number;              // relevance score 0-1
  timestamp?: string;
  status?: 'pending' | 'consolidated';
}
```

### Loop Configuration
```typescript
interface MemoryLoopsConfig {
  fastLoop: {
    enabled: boolean;
    tickIntervalSec: number;      // default 120
    idleThresholdSec: number;     // default 300
    turnCap: number;              // default 40
    minNewTurns: number;          // default 4
  };
  slowLoop: {
    enabled: boolean;
    intervalSec: number;          // default 3600
    batchSize: number;            // default 10
  };
  modelOverride?: string;
  episodeArchiveAgeDays: number;  // default 14
  topicBudget: number;            // default 4000
}
```

---

## UI Mockup Reference

A visual mockup demonstrating the complete design is available at `/mockups/memory-app-redesign.html`. The mockup implements all BOS Style Guide conventions and serves as the normative reference for:

- Color palette (opacity-based)
- Typography (text-xs default, dense spacing)
- Component patterns (buttons, inputs, toggles, cards)
- Icon usage (lucide-react)
- Layout structure (two-pane, tabs, filters)
- Interaction states (hover, selected, disabled)

---

## Implementation Plan

### Phase 1: Backend API Verification & Completion

**Goal**: Ensure all required API endpoints exist and function correctly.

**Tasks**:
1. Verify existing endpoints (`/api/memory`, `/api/memory/search`, `/api/memory/consolidate`)
2. Implement missing episode endpoints (`GET /api/memory/episodes`, `GET /api/memory/episodes/:filename`, `DELETE /api/memory/episodes/:filename`)
3. Implement topic management endpoints (if not fully implemented)
4. Add configuration endpoints for `memoryLoops` namespace
5. Write API tests for all endpoints

**Acceptance**: All endpoints return correct data; errors handled gracefully.

### Phase 2: App Replacement

**Goal**: Replace the existing Memory app with the new implementation.

**Tasks**:
1. Backup current `src/apps/memory/` directory (for reference only, not migration)
2. Create new `src/apps/memory/manifest.ts` with updated metadata
3. Create new `src/apps/memory/index.tsx` with 5-tab structure
4. Implement tab switching logic with state management
5. Add lucide-react icons for each tab
6. Style tabs per BOS conventions

**Acceptance**: New app launches correctly; all 5 tabs render and switch.

### Phase 3: Profile & Notes Tab (Backward Compatibility)

**Goal**: Preserve existing functionality with enhanced display.

**Tasks**:
1. Implement two-pane layout for USER.md and MEMORY.md
2. Add budget bars with color coding
3. Integrate existing add/edit/delete controls
4. Add info banner for "next conversation" warning
5. Display topic link counts for relevant entries

**Acceptance**: Existing functionality preserved; new visual enhancements work.

### Phase 4: Episodes Tab

**Goal**: Full episode browsing and management.

**Tasks**:
1. Implement two-pane layout (list + details)
2. Connect to episode API endpoints
3. Add filter controls (All/Pending/Consolidated)
4. Display episode metadata and all sections
5. Implement action buttons (Review, Archive, Delete)
6. Add navigation (Previous/Next)

**Acceptance**: Episodes list loads; details display correctly; actions work.

### Phase 5: Topics Tab

**Goal**: Topic browsing and entry management.

**Tasks**:
1. Implement two-pane layout (list + details)
2. Connect to topic API endpoints
3. Display budget bars and entry counts
4. Implement entry CRUD operations
5. Add topic search/filter

**Acceptance**: Topics list loads; entries display; CRUD operations work.

### Phase 6: Memory Loops Tab

**Goal**: Configuration and monitoring interface.

**Tasks**:
1. Implement configuration sections with form controls
2. Connect to `memoryLoops` config namespace
3. Build toggle switches, numeric inputs, dropdowns
4. Display run history from central logging
5. Implement manual trigger buttons with feedback
6. Add Save/Reset functionality

**Acceptance**: Configuration loads; changes persist; triggers work; history displays.

### Phase 7: Search Tab

**Goal**: Cross-surface search with relevance ranking.

**Tasks**:
1. Implement search box with debounce
2. Connect to `/api/memory/search` endpoint
3. Display results with provenance and scores
4. Add source filter controls
5. Implement result navigation (deferred if complex)

**Acceptance**: Search executes; results display; filters work.

### Phase 8: Polish & Testing

**Goal**: Refine UX, fix bugs, ensure compliance.

**Tasks**:
1. Responsive design testing (<900px)
2. Loading states and error handling
3. Accessibility audit (ARIA, keyboard nav)
4. TypeScript linting fixes
5. Performance optimization (pagination, caching)
6. Documentation updates (`docs/usage/apps/memory.md`, `docs/dev/memory/memory.md`)

**Acceptance**: All tests pass; UI responsive; docs updated.

---

## API Design Specifications

### Episode Endpoints

```typescript
// List all episodes with metadata
GET /api/memory/episodes
Response: {
  pending: EpisodeMeta[];
  consolidated: EpisodeMeta[];
}

// Get specific episode content
GET /api/memory/episodes/:filename
Response: Episode // full episode object with sections

// Delete an episode
DELETE /api/memory/episodes/:filename
Response: { success: true }
```

### Topic Endpoints

```typescript
// List all topics
GET /api/memory/topics
Response: TopicMeta[]

// Get topic content
GET /api/memory?topic=<slug>
Response: {
  topic: string;
  digest: string;
  entries: Array<{ id: number; text: string; timestamp: string }>;
}

// Add entry to topic
POST /api/memory
Body: { target: "topic"; action: "add"; topic: string; content: string }
Response: { success: true; newId: number }

// Replace entry in topic
POST /api/memory
Body: { target: "topic"; action: "replace"; topic: string; id: number; content: string }
Response: { success: true }

// Delete entry from topic
DELETE /api/memory?target=topic&topic=<slug>&id=<number>
Response: { success: true }
```

### Search Endpoint

```typescript
// Search across all surfaces
GET /api/memory/search?q=<query>&maxResults=<number>
Response: {
  query: string;
  results: SearchResult[];
}
```

### Configuration Endpoints

```typescript
// Load memoryLoops config
GET /api/config?namespace=memoryLoops
Response: MemoryLoopsConfig

// Save memoryLoops config
POST /api/config
Body: { namespace: "memoryLoops"; values: Partial<MemoryLoopsConfig> }
Response: { success: true }
```

### Manual Trigger Endpoints

```typescript
// Trigger slow loop immediately
POST /api/memory/consolidate
Response: { success: true; processed: number }

// Trigger fast loop for specific conversation
POST /api/assistant/reflect
Body: { conversationId: string }
Response: { success: true; episodeCreated: boolean }
```

---

## Success Criteria

### Measurable Outcomes

- **SC-001**: 100% of users can view episodes, topics, and loop configuration within the app.
- **SC-002**: All API endpoints respond within 200ms for typical datasets (<100 episodes, <50 topics).
- **SC-003**: No TypeScript errors or lint warnings; `npx tsc --noEmit` and `npm run lint` pass.
- **SC-004**: Responsive design works on screens 320px–1920px wide.
- **SC-005**: Accessibility score >90 on Lighthouse audit (keyboard nav, ARIA labels).
- **SC-006**: Backward compatibility: existing USER.md/MEMORY.md functionality unchanged.
- **SC-007**: The old Memory app code is completely replaced; no legacy code remains.

---

## Dependencies

### Required Prerequisites

1. **Spec 021-memory-loops** must be fully implemented (episodes store, topics, automated loops)
2. **Unified Scheduler Engine** must be operational (for loop management)
3. **Central Logging** must capture loop run history
4. **Configuration System** must support `memoryLoops` namespace

### Backend Dependencies

- Episode service (`src/lib/agent/memory/episodes.ts`)
- Topic service (`src/lib/agent/memory/topics.ts`)
- Search service (`src/lib/agent/memory/search.ts`)
- Configuration API (`/api/config`)
- Manual trigger endpoints (`/api/memory/consolidate`, `/api/assistant/reflect`)

### Frontend Dependencies

- None new; uses existing BOS stack (Tailwind v4, lucide-react, Zustand)

---

## Important Notes

- **App Replacement**: This spec **replaces** the existing Memory app at `src/apps/memory/`. The old code should not be migrated; it should be completely rewritten according to this spec.
- **Backend First**: Phase 1 (API verification) is critical; UI cannot proceed without working endpoints.
- **Mockup Reference**: The HTML mockup at `/mockups/memory-app-redesign.html` is the normative UI reference.
- **Documentation**: Update `docs/usage/apps/memory.md` and `docs/dev/memory/memory.md` to reflect new tabs and features.
- **Discrepancies**: If implementation diverges from spec, record in `specs/discrepancies.md`.

---

## Bundled Artifacts

```
bos-system-specs/023-memory-app/
├── spec.md                         this specification
├── plan.md                         (generated by specify step)
└── tasks.md                        (generated by plan step)
```

The visual mockup exists separately at `/mockups/memory-app-redesign.html`.
