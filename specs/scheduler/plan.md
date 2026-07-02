# Scheduler Implementation Plan

This document outlines the phased approach to implementing the Scheduler feature for BrowserOS.

## Phase 1: Core Data Model and Storage (P1)

### Goal
Establish the foundational data structures and persistence layer for scheduled tasks.

### Tasks
1. **Define TypeScript types** for Task, ScheduleConfig, TaskExecution
2. **Create storage module** (`src/lib/scheduler/storage.ts`)
   - Load/save tasks from `data/scheduler/tasks.json`
   - Load/save execution history from `data/scheduler/executions/`
   - Implement atomic writes to prevent corruption
3. **Implement task CRUD operations**
   - `createTask(task: TaskInput): Promise<Task>`
   - `getTask(taskId: string): Promise<Task | null>`
   - `updateTask(taskId: string, updates: Partial<Task>): Promise<Task>`
   - `deleteTask(taskId: string): Promise<void>`
   - `listTasks(): Promise<Task[]>`
   - `pauseTask(taskId: string): Promise<Task>`
   - `resumeTask(taskId: string): Promise<Task>`

### Acceptance Criteria
- Tasks can be created, read, updated, and deleted
- Data persists across restarts
- Execution history is recorded for each task

## Phase 2: Schedule Calculation Engine (P1)

### Goal
Implement the logic for calculating next run times based on schedule configurations.

### Tasks
1. **Create schedule engine** (`src/lib/scheduler/schedule.ts`)
   - `calculateNextRun(scheduleConfig, lastExecution?): DateTime`
   - Support one-time schedules
   - Support recurring schedules (minute, hour, day, week intervals)
2. **Implement schedule validation**
   - Validate that schedule configurations are valid
   - Provide clear error messages for invalid schedules

### Acceptance Criteria
- One-time tasks have correct nextRunAt
- Recurring tasks calculate future run times correctly
- Invalid schedules are rejected with helpful errors

## Phase 3: Daemon Implementation (P1)

### Goal
Create the background daemon that monitors and executes scheduled tasks.

### Tasks
1. **Create daemon module** (`src/lib/scheduler/daemon.ts`)
   - Main loop that runs every 60 seconds
   - Check for due tasks
   - Execute tasks by invoking agent runtime
2. **Implement task execution**
   - Send prompt to designated agent
   - Capture execution results
   - Record execution history
   - Update nextRunAt based on schedule type
3. **Add error handling and resilience**
   - Catch and log execution errors
   - Ensure daemon continues running after failures
4. **Integrate with BOS logging** (`017-central-logging`)
   - Log all daemon activities
   - Include timing and outcome information

### Acceptance Criteria
- Daemon starts automatically when BOS starts
- Tasks execute at their scheduled times
- Errors are logged but don't crash the daemon
- Execution history is recorded

## Phase 4: MCP Tools for Agents (P1)

### Goal
Expose scheduler functionality to agents via MCP tools.

### Tasks
1. **Create MCP server module** (`src/lib/scheduler/mcp-server.ts`)
   - Implement all required tools:
     - `listScheduledTasks()`
     - `createTask(name, prompt, agentId, scheduleType, scheduleConfig)`
     - `getTask(taskId)`
     - `updateTask(taskId, updates)`
     - `pauseTask(taskId)`
     - `resumeTask(taskId)`
     - `deleteTask(taskId)`
     - `runTaskNow(taskId)`
     - `updateTaskSchedule(taskId, newScheduleConfig)`
2. **Register MCP server** with BOS's MCP system
   - Provide tool descriptions and schemas
   - Ensure proper error responses
3. **Add per-agent scoping support** (`011-per-agent-capabilities`)
   - Allow scheduler tools to be scoped per agent

### Acceptance Criteria
- Agents can list, create, modify, pause, resume, delete, and trigger tasks
- Tool schemas are clear and well-documented
- Errors are returned in a usable format

## Phase 5: Scheduler App UI (P1)

### Goal
Build the React application for managing scheduled tasks.

### Tasks
1. **Create app structure** (`src/apps/scheduler/`)
   - Main component with task list view
   - Task detail/edit modal
   - "Schedule New Task" form
2. **Implement task list view**
   - Display tasks sorted by nextRunAt
   - Show: name, agent, next run time, status
   - Action buttons: Run Now, Pause/Resume, Delete, Edit
3. **Implement task creation form**
   - Name input
   - Prompt textarea
   - Agent selector (dropdown of available agents)
   - Schedule type selector (one-time / recurring)
   - Schedule-specific inputs (datetime picker or interval selectors)
4. **Implement task editing**
   - Pre-fill form with existing task data
   - Allow updates to name, prompt, and schedule
5. **Add confirmation dialogs** for destructive actions (delete)
6. **Style the app** to match BOS design language

### Acceptance Criteria
- Users can view all tasks sorted by next run time
- Users can create new tasks via the UI
- Users can edit existing tasks
- Users can pause, resume, delete, and manually trigger tasks
- The UI is responsive and matches BOS styling

## Phase 6: Assistant Integration (P2)

### Goal
Enable natural language task scheduling through the assistant.

### Tasks
1. **Create assistant flow** for "schedule a task"
   - Detect when user wants to schedule a task
   - Guide user through: prompt → agent → schedule
   - Use the MCP tools to create the task
2. **Add elicitation prompts** for missing information
   - "What would you like the task to do?"
   - "Which agent should handle this?"
   - "When should it run? (one-time at [datetime] or recurring every [interval])"
3. **Provide feedback** after task creation
   - Confirm task was created
   - Show when it will next run

### Acceptance Criteria
- Users can schedule tasks through natural conversation
- The assistant guides users through all required information
- Task creation is confirmed with details

## Phase 7: Logging and Monitoring (P2)

### Goal
Ensure comprehensive logging and add monitoring features.

### Tasks
1. **Enhance logging** throughout the system
   - Task lifecycle events (create, update, delete, pause, resume)
   - Execution events (start, success, error, duration)
   - Daemon lifecycle (start, stop, reload)
2. **Add execution history view** in the UI
   - Show past executions for each task
   - Display timestamps, status, and outcomes
3. **Integrate with BOS logging viewer**
   - Ensure scheduler logs appear in Settings → Logs
   - Filter by `component: scheduler`

### Acceptance Criteria
- All scheduler activities are logged
- Users can view execution history in the UI
- Logs are searchable and filterable

## Phase 8: Edge Cases and Polish (P3)

### Goal
Handle edge cases and polish the user experience.

### Tasks
1. **Handle past-due tasks on startup**
   - Detect tasks with nextRunAt in the past
   - Either execute immediately or mark for review
2. **Add task templates** (optional, nice-to-have)
   - Pre-defined task patterns for common use cases
3. **Implement task search/filter** in the UI
   - Filter by agent, status, or schedule type
4. **Add timezone handling**
   - Ensure schedules work correctly across timezones
5. **Performance optimization**
   - Efficient task checking for large numbers of tasks
   - Lazy loading of execution history

### Acceptance Criteria
- Edge cases are handled gracefully
- The system performs well with many tasks
- User experience is polished and intuitive

## Dependencies

- **Phase 1**: None (foundational)
- **Phase 2**: Phase 1 complete
- **Phase 3**: Phases 1-2 complete, depends on agent runtime availability
- **Phase 4**: Phase 3 complete, depends on MCP gateway (`014-mcp-tool-gateway`)
- **Phase 5**: Phase 3 complete (needs daemon for real-time updates)
- **Phase 6**: Phases 1-4 complete
- **Phase 7**: All previous phases
- **Phase 8**: All previous phases

## Implementation Order Recommendation

1. Start with **Phase 1** to establish the data model
2. Build **Phase 2** for schedule calculations
3. Implement **Phase 3** (daemon) - this is the core engine
4. Add **Phase 4** (MCP tools) so agents can interact
5. Build **Phase 5** (UI) for direct user interaction
6. Add **Phase 6** (assistant integration) for natural language
7. Enhance with **Phase 7** (logging/monitoring)
8. Polish with **Phase 8** (edge cases)

## Testing Strategy

### Unit Tests
- Schedule calculation logic
- Storage operations
- Task state transitions

### Integration Tests
- Daemon execution flow
- MCP tool calls
- End-to-end task lifecycle

### Manual Testing
- Create tasks via UI and assistant
- Verify execution at scheduled times
- Test pause/resume/delete operations
- Verify logging output

## Success Metrics

- Tasks execute at their scheduled times (measured by execution logs)
- No daemon crashes during normal operation
- Users can successfully create and manage tasks via both UI and assistant
- Execution history is accurately recorded and viewable
