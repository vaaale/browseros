# Scheduler Implementation Tasks

These are the concrete tasks to implement the Scheduler feature. Each task includes acceptance criteria and links to relevant code areas.

## Task 1: Define TypeScript Types

**Priority**: P1  
**Status**: Not Started  
**Files**: `src/lib/scheduler/types.ts`

### Description
Create the core TypeScript type definitions for the scheduler system.

### Implementation Details
```typescript
// Schedule types
type ScheduleType = 'one-time' | 'recurring';

interface OneTimeSchedule {
  type: 'one-time';
  datetime: string; // ISO 8601
}

interface RecurringSchedule {
  type: 'recurring';
  interval: number;
  unit: 'minute' | 'hour' | 'day' | 'week';
  startTime?: string; // ISO 8601, optional (defaults to now)
}

type ScheduleConfig = OneTimeSchedule | RecurringSchedule;

// Task status
type TaskStatus = 'active' | 'paused' | 'completed';

// Execution record
interface TaskExecution {
  id: string;
  taskId: string;
  executedAt: string; // ISO 8601
  status: 'success' | 'error';
  duration: number; // milliseconds
  output?: string;
  error?: string;
}

// Main task entity
interface Task {
  id: string;
  name: string;
  prompt: string;
  agentId: string;
  scheduleType: ScheduleType;
  scheduleConfig: ScheduleConfig;
  status: TaskStatus;
  nextRunAt: string | null; // ISO 8601, null if paused
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601;
  executionHistory: TaskExecution[];
}

// Input for creating a task
interface CreateTaskInput {
  name: string;
  prompt: string;
  agentId: string;
  scheduleConfig: ScheduleConfig;
}

// Updates that can be made to a task
interface UpdateTaskInput {
  name?: string;
  prompt?: string;
  scheduleConfig?: ScheduleConfig;
}
```

### Acceptance Criteria
- [ ] All types are defined and exported
- [ ] Types use proper TypeScript strict mode
- [ ] Types are documented with JSDoc comments
- [ ] Types are used consistently throughout the codebase

---

## Task 2: Implement Storage Module

**Priority**: P1  
**Status**: Not Started  
**Files**: `src/lib/scheduler/storage.ts`

### Description
Create the storage layer for persisting tasks and execution history.

### Implementation Details
- Use BOS's data directory structure (`data/scheduler/`)
- Implement atomic writes (write to temp file, then rename)
- Handle missing files gracefully (initialize empty state)
- Provide async methods for all operations

### Key Functions
```typescript
const TASKS_FILE = 'data/scheduler/tasks.json';
const EXECUTIONS_DIR = 'data/scheduler/executions';

async function loadTasks(): Promise<Task[]>
async function saveTasks(tasks: Task[]): Promise<void>
async function loadExecutionHistory(taskId: string): Promise<TaskExecution[]>
async function saveExecutionHistory(taskId: string, executions: TaskExecution[]): Promise<void>
async function recordExecution(taskId: string, execution: TaskExecution): Promise<void>
```

### Acceptance Criteria
- [ ] Tasks can be loaded and saved
- [ ] Execution history is persisted per task
- [ ] Atomic writes prevent corruption
- [ ] Missing files are handled gracefully
- [ ] All operations are async and properly error-handled

---

## Task 3: Implement CRUD Operations

**Priority**: P1  
**Status**: Not Started  
**Files**: `src/lib/scheduler/task-service.ts`

### Description
Implement the task service with all CRUD operations.

### Key Functions
```typescript
async function createTask(input: CreateTaskInput): Promise<Task>
async function getTask(taskId: string): Promise<Task | null>
async function updateTask(taskId: string, updates: UpdateTaskInput): Promise<Task>
async function deleteTask(taskId: string): Promise<void>
async function listTasks(): Promise<Task[]>
async function pauseTask(taskId: string): Promise<Task>
async function resumeTask(taskId: string): Promise<Task>
```

### Acceptance Criteria
- [ ] All CRUD operations work correctly
- [ ] Task IDs are UUIDs
- [ ] Timestamps are properly set (createdAt, updatedAt, nextRunAt)
- [ ] Paused tasks have null nextRunAt
- [ ] Resumed tasks recalculate nextRunAt

---

## Task 4: Implement Schedule Calculation Engine

**Priority**: P1  
**Status**: Not Started  
**Files**: `src/lib/scheduler/schedule.ts`

### Description
Implement the logic for calculating next run times.

### Key Functions
```typescript
function calculateNextRun(scheduleConfig: ScheduleConfig, lastExecution?: Date): Date
function validateSchedule(scheduleConfig: ScheduleConfig): void | never
function parseInterval(interval: number, unit: string): number // returns milliseconds
```

### Schedule Logic
- **One-time**: nextRunAt = scheduled datetime
- **Recurring**: 
  - First run: startTime (or now) + interval
  - Subsequent: lastExecution + interval

### Acceptance Criteria
- [ ] One-time schedules calculate correctly
- [ ] Recurring schedules with minutes work
- [ ] Recurring schedules with hours work
- [ ] Recurring schedules with days work
- [ ] Recurring schedules with weeks work
- [ ] Invalid schedules throw descriptive errors
- [ ] Timezone handling is correct (use UTC internally)

---

## Task 5: Implement Daemon Loop

**Priority**: P1  
**Status**: Not Started  
**Files**: `src/lib/scheduler/daemon.ts`

### Description
Create the background daemon that monitors and executes tasks.

### Implementation Details
```typescript
class SchedulerDaemon {
  private intervalId: NodeJS.Timeout | null = null
  private checkIntervalMs: number = 60000 // 60 seconds
  
  async start(): Promise<void>
  async stop(): Promise<void>
  private async runLoop(): Promise<void>
  private async checkAndExecuteDueTasks(): Promise<void>
  private async executeTask(task: Task): Promise<void>
}
```

### Execution Flow
1. Load all active tasks
2. For each task, check if `nextRunAt <= now`
3. If due, execute the task:
   - Send prompt to agent
   - Capture result
   - Record execution
   - Update nextRunAt (or mark completed for one-time)
4. Log the operation
5. Wait for next interval

### Acceptance Criteria
- [ ] Daemon starts automatically on BOS startup
- [ ] Daemon stops gracefully on BOS shutdown
- [ ] Tasks execute at their scheduled times
- [ ] Execution errors are logged but don't crash daemon
- [ ] One-time tasks are marked completed after execution
- [ ] Recurring tasks have nextRunAt updated correctly

---

## Task 6: Implement Agent Invocation

**Priority**: P1  
**Status**: Not Started  
**Files**: `src/lib/scheduler/executor.ts`

### Description
Implement the logic for sending prompts to agents.

### Implementation Details
- Use existing agent runtime to invoke the specified agent
- Create a new conversation or use a system conversation for scheduled tasks
- Capture the agent's response
- Handle errors gracefully

### Key Functions
```typescript
interface ExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  duration: number;
}

async function executeTaskPrompt(agentId: string, prompt: string): Promise<ExecutionResult>
```

### Acceptance Criteria
- [ ] Prompts are sent to the correct agent
- [ ] Agent responses are captured
- [ ] Execution time is measured
- [ ] Errors are caught and reported
- [ ] Uses existing BOS agent infrastructure

---

## Task 7: Create MCP Server for Agents

**Priority**: P1  
**Status**: Not Started  
**Files**: `src/lib/scheduler/mcp-server.ts`

### Description
Expose scheduler functionality as MCP tools for agents.

### Tools to Implement
```typescript
// Tool definitions
{
  name: 'listScheduledTasks',
  description: 'List all scheduled tasks',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => listTasks()
}

{
  name: 'createTask',
  description: 'Create a new scheduled task',
  inputSchema: { 
    type: 'object',
    properties: {
      name: { type: 'string' },
      prompt: { type: 'string' },
      agentId: { type: 'string' },
      scheduleType: { type: 'string', enum: ['one-time', 'recurring'] },
      scheduleConfig: { type: 'object' }
    },
    required: ['name', 'prompt', 'agentId', 'scheduleType', 'scheduleConfig']
  },
  handler: async (args) => createTask(args)
}

// ... similar for getTask, updateTask, pauseTask, resumeTask, deleteTask, runTaskNow, updateTaskSchedule
```

### Acceptance Criteria
- [ ] All required tools are implemented
- [ ] Tool schemas are correct and validated
- [ ] Tools return proper error responses
- [ ] MCP server is registered with BOS
- [ ] Tools work through the MCP gateway

---

## Task 8: Register MCP Server with BOS

**Priority**: P1  
**Status**: Not Started  
**Files**: `src/lib/mcp/registry.ts` (or create scheduler-specific registration)

### Description
Integrate the scheduler MCP server into BOS's MCP system.

### Implementation Details
- Register the scheduler as an MCP server
- Provide server description for agent context
- Ensure tools are discoverable via `findTools` and `listMcpServerTools`

### Acceptance Criteria
- [ ] Scheduler appears in MCP server list
- [ ] Tools are discoverable by agents
- [ ] Server description is informative
- [ ] Per-agent scoping works (if enabled)

---

## Task 9: Create Scheduler App Structure

**Priority**: P1  
**Status**: Not Started  
**Files**: `src/apps/scheduler/`

### Description
Set up the React app structure for the Scheduler UI.

### File Structure
```
src/apps/scheduler/
  index.tsx          # Main app entry
  SchedulerApp.tsx   # Root component
  TaskList.tsx       # Task list view
  TaskForm.tsx       # Create/Edit form
  TaskDetail.tsx     # Task detail/history view
  types.ts           # UI-specific types
  styles.css         # App styles
```

### Acceptance Criteria
- [ ] App structure is created
- [ ] App can be opened from the app launcher
- [ ] Basic routing/navigation works
- [ ] Styles match BOS design language

---

## Task 10: Implement Task List View

**Priority**: P1  
**Status**: Not Started  
**Files**: `src/apps/scheduler/TaskList.tsx`

### Description
Create the main task list view.

### Features
- Display tasks sorted by nextRunAt (soonest first)
- Show columns: Name, Agent, Next Run, Status
- Action buttons: Run Now, Pause/Resume, Delete, Edit
- Empty state with "Schedule New Task" button
- Real-time updates (refresh when tasks change)

### Acceptance Criteria
- [ ] Tasks are sorted by nextRunAt
- [ ] All task information is displayed
- [ ] Action buttons work correctly
- [ ] Empty state is shown when no tasks exist
- [ ] List updates when tasks are modified

---

## Task 11: Implement Task Form (Create/Edit)

**Priority**: P1  
**Status**: Not Started  
**Files**: `src/apps/scheduler/TaskForm.tsx`

### Description
Create the form for creating and editing tasks.

### Fields
- Name (text input, required)
- Prompt (textarea, required)
- Agent (dropdown of available agents, required)
- Schedule Type (radio: one-time / recurring, required)
- If one-time: Date/Time picker (required)
- If recurring: 
  - Interval number (required, min 1)
  - Unit dropdown (minute/hour/day/week, required)
  - Start time (optional, defaults to now)

### Acceptance Criteria
- [ ] All fields are present and validated
- [ ] Schedule type toggles appropriate inputs
- [ ] Form validates before submission
- [ ] Create and edit modes work correctly
- [ ] Success/error feedback is shown

---

## Task 12: Implement Task Detail/History View

**Priority**: P2  
**Status**: Not Started  
**Files**: `src/apps/scheduler/TaskDetail.tsx`

### Description
Show task details and execution history.

### Features
- Task information (name, prompt, agent, schedule)
- Execution history table:
  - Executed At
  - Status (success/error)
  - Duration
  - Output/Error summary
- Expandable rows for full output/error

### Acceptance Criteria
- [ ] Task details are displayed
- [ ] Execution history is shown
- [ ] History entries can be expanded
- [ ] Empty state when no executions exist

---

## Task 13: Implement Assistant Integration Flow

**Priority**: P2  
**Status**: Not Started  
**Files**: `src/assistant/scheduler-flow.ts` (or integrate into existing assistant logic)

### Description
Enable natural language task scheduling through the assistant.

### Flow
1. Detect "schedule a task" intent
2. Ask for task description/prompt
3. Ask which agent to use
4. Ask for schedule (one-time or recurring with details)
5. Create the task using MCP tools
6. Confirm creation with details

### Acceptance Criteria
- [ ] Assistant detects scheduling intent
- [ ] Assistant guides user through all required information
- [ ] Task is created via MCP tools
- [ ] User receives confirmation with task details

---

## Task 14: Add Logging Integration

**Priority**: P2  
**Status**: Not Started  
**Files**: `src/lib/scheduler/logger.ts`

### Description
Integrate scheduler operations with BOS's central logging system.

### Events to Log
- Task created/updated/deleted/paused/resumed
- Task execution started/completed/failed
- Daemon started/stopped/reloaded
- Schedule calculation errors
- Storage errors

### Implementation
```typescript
import { log } from '../logging/service';

log.info({ component: 'scheduler', action: 'task_created', taskId, taskName });
log.error({ component: 'scheduler', action: 'execution_failed', taskId, error });
```

### Acceptance Criteria
- [ ] All operations are logged
- [ ] Logs include relevant context (taskId, taskName, etc.)
- [ ] Errors include stack traces
- [ ] Logs appear in BOS Settings → Logs
- [ ] Logs can be filtered by component: scheduler

---

## Task 15: Handle Past-Due Tasks on Startup

**Priority**: P3  
**Status**: Not Started  
**Files**: `src/lib/scheduler/daemon.ts` (startup logic)

### Description
Handle tasks that were due while BOS was offline.

### Options (choose one or make configurable)
- Execute immediately on startup
- Mark as "overdue" for manual review
- Skip and wait for next scheduled time

### Implementation
```typescript
async function handlePastDueTasks(tasks: Task[]): Promise<void> {
  const now = new Date();
  const pastDue = tasks.filter(t => 
    t.status === 'active' && 
    t.nextRunAt !== null && 
    new Date(t.nextRunAt) < now
  );
  
  // Execute or mark based on policy
}
```

### Acceptance Criteria
- [ ] Past-due tasks are detected on startup
- [ ] Configurable behavior for handling past-due tasks
- [ ] Actions are logged appropriately

---

## Task 16: Add Task Search/Filter in UI

**Priority**: P3  
**Status**: Not Started  
**Files**: `src/apps/scheduler/TaskList.tsx`

### Description
Add filtering capabilities to the task list.

### Filters
- By status (active/paused/completed)
- By agent
- By schedule type
- Search by name

### Acceptance Criteria
- [ ] Filter controls are present
- [ ] Filters work correctly
- [ ] Multiple filters can be combined
- [ ] Clear filter option is available

---

## Task 17: Add Confirmation Dialogs

**Priority**: P3  
**Status**: Not Started  
**Files**: `src/apps/scheduler/` (use existing BOS dialog system)

### Description
Add confirmation dialogs for destructive actions.

### Actions Requiring Confirmation
- Delete task
- Run task now (optional, if it might have side effects)

### Acceptance Criteria
- [ ] Delete shows confirmation dialog
- [ ] User can cancel the action
- [ ] Confirmation message is clear

---

## Task 18: Timezone Handling

**Priority**: P3  
**Status**: Not Started  
**Files**: `src/lib/scheduler/schedule.ts`

### Description
Ensure schedules work correctly across timezones.

### Implementation
- Store all times in UTC internally
- Convert to local timezone for UI display
- Allow users to specify timezone for recurring tasks (optional)

### Acceptance Criteria
- [ ] Times are stored in UTC
- [ ] UI displays times in user's local timezone
- [ ] Schedules execute at the correct absolute time regardless of timezone changes

---

## Task 19: Performance Optimization

**Priority**: P3  
**Status**: Not Started  
**Files**: `src/lib/scheduler/`

### Description
Optimize for large numbers of tasks.

### Optimizations
- Efficient task checking (skip paused/completed)
- Lazy loading of execution history
- Debounced UI updates
- Indexed storage lookups

### Acceptance Criteria
- [ ] Daemon loop remains efficient with 100+ tasks
- [ ] UI remains responsive with many tasks
- [ ] Execution history doesn't slow down task listing

---

## Task 20: Write Unit Tests

**Priority**: P3  
**Status**: Not Started  
**Files**: `src/lib/scheduler/*.test.ts`

### Description
Write comprehensive unit tests for the scheduler logic.

### Test Coverage
- Schedule calculation (all schedule types)
- Task CRUD operations
- Storage operations
- Daemon loop logic
- MCP tool handlers

### Acceptance Criteria
- [ ] All critical paths are tested
- [ ] Tests pass consistently
- [ ] Code coverage is adequate (>80%)

---

## Task 21: Write Integration Tests

**Priority**: P3  
**Status**: Not Started  
**Files**: `tests/scheduler/*.test.ts`

### Description
Write integration tests for end-to-end scenarios.

### Test Scenarios
- Create task → wait → verify execution
- Pause task → verify not executed
- Resume task → verify execution resumes
- Delete task → verify removed from storage
- MCP tool calls → verify task changes

### Acceptance Criteria
- [ ] Integration tests cover main workflows
- [ ] Tests can be run automatically
- [ ] Tests catch regressions

---

## Task 22: Documentation

**Priority**: P3  
**Status**: Not Started  
**Files**: `docs/usage/scheduler.md`

### Description
Write user documentation for the Scheduler app.

### Content
- Overview of scheduling capabilities
- How to schedule via assistant
- How to use the UI
- Schedule types explained
- Managing tasks (pause, resume, delete)
- Troubleshooting

### Acceptance Criteria
- [ ] Documentation is clear and complete
- [ ] Examples are provided
- [ ] Screenshots are included (if applicable)
