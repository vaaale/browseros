# Implementation Plan: Memory App Redesign

**Feature**: `023-memory-app`  
**Branch**: `bos/023-memory-app`  
**Status**: Ready for Implementation

---

## Overview

This plan outlines the step-by-step implementation to **replace** the existing Memory app (`src/apps/memory`) with a new implementation that exposes the memory loops architecture (episodes, topics, automated loops) through a modern 5-tab interface while maintaining backward compatibility.

---

## Critical Note: App Replacement

This is **not a migration**. The existing Memory app code at `src/apps/memory/` will be **completely replaced** with new code following this spec. No legacy code should be preserved or migrated; only the functionality (USER.md/MEMORY.md management) must be maintained.

---

## Phase Breakdown

### Phase 1: Backend API Verification & Completion (4-6 hours)

**Goal**: Ensure all required API endpoints exist and function correctly before UI development.

#### Tasks:

**1.1 Verify Spec 021 Implementation**
- Check that `/Documents/Memory/Episodes/` directory structure exists with sample files
- Verify topic files in `/Documents/Memory/Topics/`
- Confirm watermarks file at `/Documents/Memory/.watermarks.json`
- Validate scheduler jobs for fast/slow loops in `/Documents/System/scheduler-jobs.json`

**1.2 Backend API Audit**
- Test existing endpoints: `GET /api/memory`, `POST /api/memory`, `GET /api/memory/search`
- Verify manual triggers: `POST /api/memory/consolidate`, `POST /api/assistant/reflect`
- Check config namespace: `GET /api/config?namespace=memoryLoops`

**1.3 Identify Gaps**
- List missing episode endpoints (list, get, delete)
- List missing topic management endpoints (if any)
- Document required changes to backend services

**Deliverable**: Gap analysis report with prioritized backend tasks.

---

### Phase 2: App Replacement (2-3 hours)

**Goal**: Replace the existing Memory app with new implementation structure.

#### Tasks:

**2.1 Backup Existing Code**
- Copy `src/apps/memory/` to `src/apps/memory-backup/` (reference only, not for migration)
- Document what functionality exists in the old app

**2.2 Update App Manifest**
```typescript
// File: src/apps/memory/manifest.ts (replace entirely)
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

**2.3 Create New Main Component**
```typescript
// File: src/apps/memory/index.tsx (replace entirely)
"use client";

import { useState, useEffect } from "react";
import type { AppProps } from "@/components/apps/types";
import { useOSStore } from "@/store/os-provider";
import { Brain, FileText, BookOpen, Settings, Search } from "lucide-react";

export default function MemoryApp({ windowId }: AppProps) {
  // Implementation with 5 tabs
}
```

**2.4 Create Tab Component Stubs**
- `src/apps/memory/components/ProfileTab.tsx` (stub)
- `src/apps/memory/components/EpisodesTab.tsx` (stub)
- `src/apps/memory/components/TopicsTab.tsx` (stub)
- `src/apps/memory/components/LoopsTab.tsx` (stub)
- `src/apps/memory/components/SearchTab.tsx` (stub)

**Acceptance Criteria**:
- Old code removed; new app compiles
- All 5 tabs render and switch correctly
- No TypeScript errors

---

### Phase 3: Profile & Notes Tab (2-3 hours)

**Goal**: Implement backward-compatible profile management with enhancements.

#### Tasks:

**3.1 Two-Pane Layout**
- Create User Profile pane (left) with USER.md entries
- Create Agent Notes pane (right) with MEMORY.md entries
- Add independent add/edit/delete controls for each pane

**3.2 Data Loading**
```typescript
const [userEntries, setUserEntries] = useState<string[]>([]);
const [memoryEntries, setMemoryEntries] = useState<string[]>([]);

useEffect(() => {
  const load = async () => {
    const [userRes, memoryRes] = await Promise.all([
      fetch("/api/memory?target=user"),
      fetch("/api/memory?target=memory")
    ]);
    setUserEntries((await userRes.json()).entries);
    setMemoryEntries((await memoryRes.json()).entries);
  };
  load();
}, []);
```

**3.3 Budget Display**
- Add visual budget bars for USER.md (1200 chars) and MEMORY.md (2000 chars)
- Color coding: green (<50%), amber (50-80%), red (>80%)

**3.4 Entry Management**
- Implement "Add" button with modal or inline input
- Connect to `POST /api/memory` for add/replace/remove
- Add delete with confirmation dialog

**3.5 Info Banner**
- Display warning: "Changes take effect in your next conversation"

**Acceptance Criteria**:
- Both panes load and display entries correctly
- Budget bars update dynamically
- Add/edit/delete work as before
- Info banner visible

---

### Phase 4: Episodes Tab (3-4 hours)

**Goal**: Full episode browsing, details, and management.

#### Tasks:

**4.1 Two-Pane Layout with Filters**
- Left pane: Episode list with filter buttons (All/Pending/Consolidated)
- Right pane: Episode details view
- Implement selection state and hover effects

**4.2 Episode List Component**
```typescript
interface EpisodeMeta {
  filename: string;
  status: 'pending' | 'consolidated';
  createdAt: string;
  turnCount: number;
  skillsUsed: string[];
}

// Fetch and display list
const [episodes, setEpisodes] = useState<{ pending: EpisodeMeta[]; consolidated: EpisodeMeta[] }>({ pending: [], consolidated: [] });
```

**4.3 Episode Details Component**
- Display metadata: conversationId, timestamps, watermark, skillsUsed, status, skillCandidates
- Render all six sections: Task & Outcome, What Worked, What Failed, Corrections Received, Durable Lesson Candidates, Profile Suggestions
- Add action buttons: Review Now, Archive, Delete
- Add navigation: Previous/Next

**4.4 Connect Actions**
- "Review Now" → `POST /api/assistant/reflect` with conversationId
- "Archive" → Move to `.Archive/` (backend operation)
- "Delete" → `DELETE /api/memory/episodes/:filename` with confirmation

**Acceptance Criteria**:
- Episodes list loads and filters correctly
- Details display all sections
- Actions trigger backend operations
- Navigation works between episodes

---

### Phase 5: Topics Tab (2-3 hours)

**Goal**: Topic browsing and entry management.

#### Tasks:

**5.1 Two-Pane Layout**
- Left pane: Topic list with search box, entry counts, budget bars
- Right pane: Topic details with numbered entries

**5.2 Topic List Component**
```typescript
interface TopicMeta {
  slug: string;
  entryCount: number;
  charUsage: number;
  budget: number;
}

// Fetch and display list
const [topics, setTopics] = useState<TopicMeta[]>([]);
```

**5.3 Topic Details Component**
- Display numbered entries with content, timestamps, consolidation source
- Add "Add Entry" button with modal
- Add "Delete Entry" and "Delete Topic" buttons

**5.4 Connect Operations**
- "Add Entry" → `POST /api/memory` with `target: "topic"` and budget validation
- "Delete Entry" → `DELETE /api/memory?target=topic&topic=<slug>&id=<number>`
- "Delete Topic" → Confirm then delete entire topic file

**Acceptance Criteria**:
- Topics list loads with budgets
- Entries display with provenance
- Add/delete operations work
- Budget enforcement active

---

### Phase 6: Memory Loops Tab (3-4 hours)

**Goal**: Configuration interface and run history.

#### Tasks:

**6.1 Configuration Form**
- Fast Loop section: toggle, tick interval, idle threshold, turn cap, min new turns, model override
- Slow Loop section: toggle, interval, batch size, model override
- Advanced Settings: episode archive age, topic budget
- Save/Reset buttons

**6.2 Run History Component**
- Fetch from `/api/logs?category=memory.loops`
- Display last execution summaries for both loops
- Add manual trigger buttons with loading states

**6.3 Configuration State Management**
```typescript
const [config, setConfig] = useState<MemoryLoopsConfig | null>(null);
const [saving, setSaving] = useState(false);

useEffect(() => {
  fetch("/api/config?namespace=memoryLoops")
    .then(res => res.json())
    .then(setConfig);
}, []);

const saveConfig = async () => {
  setSaving(true);
  await fetch("/api/config", {
    method: "POST",
    body: JSON.stringify({ namespace: "memoryLoops", values: config })
  });
  setSaving(false);
};
```

**Acceptance Criteria**:
- All config fields load and display correctly
- Toggle switches, inputs, dropdowns work
- Save persists to backend
- Manual triggers execute loops
- Run history displays recent executions

---

### Phase 7: Search Tab (2-3 hours)

**Goal**: Cross-surface search with relevance ranking.

#### Tasks:

**7.1 Search Interface**
- Search box with Enter key support and debounce
- Source filter buttons (All/Topics/Episodes/Memory)
- Results count display

**7.2 Results Display**
```typescript
interface SearchResult {
  source: string;
  content: string;
  score: number;
  timestamp?: string;
  status?: 'pending' | 'consolidated';
}

// Fetch and display results
const [results, setResults] = useState<SearchResult[]>([]);

const performSearch = async () => {
  const res = await fetch(`/api/memory/search?q=${encodeURIComponent(query)}&maxResults=50`);
  const data = await res.json();
  setResults(data.results);
};
```

**7.3 Highlighting and Navigation**
- Highlight matched terms in results
- Add "Load More" pagination
- Implement result click navigation (deferred if complex)

**Acceptance Criteria**:
- Search box accepts input and executes on Enter/Click
- Results display with provenance and scores
- Highlighting works for matched terms
- Filters restrict results by source

---

### Phase 8: Polish & Testing (2-3 hours)

**Goal**: Final refinements, bug fixes, documentation.

#### Tasks:

**8.1 Responsive Design**
- Add media queries for <768px screens
- Stack two-pane layouts to single column
- Adjust font sizes and spacing

**8.2 Loading & Error States**
- Add loading spinners for all async operations
- Display error messages with retry options
- Handle empty states gracefully

**8.3 Accessibility Audit**
- Add ARIA labels to all interactive elements
- Test keyboard navigation (Tab, Enter, Escape)
- Verify focus states on all controls
- Run Lighthouse accessibility audit (target >90)

**8.4 TypeScript & Lint**
```bash
npx tsc --noEmit
npm run lint
```
- Fix all errors and warnings
- Add missing type definitions

**8.5 Documentation Updates**
- Update `docs/usage/apps/memory.md` with new features and tabs
- Update `docs/dev/memory/memory.md` with API changes
- Add screenshots if applicable

**8.6 Final Testing**
- Test all user stories from spec
- Verify backward compatibility for USER.md/MEMORY.md
- Performance test with large datasets (100+ episodes, 50+ topics)
- Cross-browser testing (Chrome, Firefox, Safari)

**Acceptance Criteria**:
- Responsive on all screen sizes
- Loading/error states displayed appropriately
- Accessibility score >90
- No TypeScript errors or lint warnings
- Documentation complete and accurate

---

## Risk Mitigation

### Known Risks

1. **Backend API Gaps**: If episode/topic endpoints are missing, Phase 1 becomes critical path.
   - **Mitigation**: Prioritize backend completion; use mock data for UI development if needed.

2. **Performance with Large Datasets**: 100+ episodes may slow list rendering.
   - **Mitigation**: Implement virtual scrolling or pagination; test with realistic data sizes.

3. **Browser Compatibility**: New CSS features may not work in all browsers.
   - **Mitigation**: Test in Chrome, Firefox, Safari; use autoprefixer for vendor prefixes.

4. **State Management Complexity**: Multiple tabs with independent state could become unwieldy.
   - **Mitigation**: Use React Context or Zustand for shared state; keep tab state local when possible.

### Rollback Plan

If critical issues arise:
1. Restore `src/apps/memory-backup/` temporarily
2. Investigate and fix issues in feature branch
3. Re-deploy when stable

---

## Success Metrics

- **Development**: All phases completed within estimated time (+/- 20%)
- **Quality**: Zero critical bugs; accessibility score >90
- **Performance**: Page load <1s; API responses <200ms
- **User Satisfaction**: Positive feedback from initial testers
- **Code Quality**: `npx tsc --noEmit` and `npm run lint` pass cleanly

---

## Next Steps

1. **Immediate**: Begin Phase 1 (Backend API Verification & Completion)
2. **After Phase 1**: Confirm backend requirements with team; start UI development with mock data if needed
3. **Parallel Development**: UI can proceed with stubs while backend is built
4. **Integration Testing**: Once both phases complete, integrate and test end-to-end
