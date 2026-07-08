# Feature Specification: Scheduler (Task Scheduling Daemon & UI)

**Feature Branch**: `scheduler`

**Created**: 2026-01-XX

**Status**: Draft

**Input**: User request for a scheduling app that allows users to schedule tasks (prompts to agents) on various schedules (once, recurring). The app must have a daemon for background execution, a UI for managing tasks, and MCP tools for agent interaction.

> This feature provides a cron-like scheduling system for BrowserOS. Tasks are prompts sent to selected agents at scheduled times. The system includes a background daemon, a management UI, and MCP tools for agent integration.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Schedule a task via the Assistant (Priority: P1)

A user tells the assistant "I want to schedule a task" and is guided through defining the task prompt, selecting an agent, and specifying when it should run.

**Acceptance Scenarios**:

1. **Given** the user says "schedule a task", **When** the assistant responds, **Then** it asks for the task description/prompt.
2. **Given** the user provides a prompt, **When** the assistant continues, **Then** it asks which agent should receive the prompt.
3. **Given** the user selects an agent, **When** the assistant continues, **Then** it asks for the schedule (one-time or recurring with interval).
4. **Given** all details are provided, **When** the task is created, **Then** it appears in the scheduler UI and will execute at the scheduled time.

### User Story 2 - View and manage scheduled tasks via UI (Priority: P1)

The user opens the Scheduler app and sees all registered tasks sorted by next run time, with options to pause, delete, or run immediately.

**Acceptance Scenarios**:

1. **Given** there are scheduled tasks, **When** the Scheduler app opens, **Then** tasks are displayed sorted by next run time (soonest first).
2. **Given** a task is shown, **When** the user clicks "Pause", **Then** the task is removed from the execution queue but preserved.
3. **Given** a paused task, **When** the user clicks "Resume", **Then** the task re-enters the execution queue.
4. **Given** a task, **When** the user clicks "Delete", **Then** the task is permanently removed after confirmation.
5. **Given** a task, **When** the user clicks "Run Now", **Then** the task executes immediately without waiting for its schedule.
6. **Given** no tasks exist, **When** the app opens, **Then** an empty state with "Schedule New Task" button is shown.

### User Story 3 - Schedule a new task via UI (Priority: P1)

The user can create a scheduled task directly from the Scheduler UI without using the assistant.

**Acceptance Scenarios**:

1. **Given** the user clicks "Schedule New Task", **When** the form opens, **Then** they can enter a task name, prompt, select an agent, and choose schedule type.
2. **Given** one-time schedule is selected, **When** the user picks a date/time, **Then** the task is scheduled for that exact moment.
3. **Given** recurring schedule is selected, **When** the user specifies interval (e.g., "every 2 hours"), **Then** the task repeats at that interval starting from now or a specified start time.
4. **Given** all fields are valid, **When** the user saves, **Then** the task is created and appears in the task list.

### User Story 4 - Agent uses scheduler tools (Priority: P1)

An agent can programmatically create, modify, list, pause, resume, delete, and trigger tasks using MCP tools provided by the scheduler.

**Acceptance Scenarios**:

1. **Given** an agent wants to list tasks, **When** it calls `listScheduledTasks`, **Then** it receives all tasks with their status and next run times.
2. **Given** an agent wants to create a task, **When** it calls `createTask` with prompt, agentId, and schedule, **Then** the task is created and returns its ID.
3. **Given** an agent wants to pause a task, **When** it calls `pauseTask(taskId)`, **Then** the task is paused.
4. **Given** an agent wants to resume a task, **When** it calls `resumeTask(taskId)`, **Then** the task resumes.
5. **Given** an agent wants to delete a task, **When** it calls `deleteTask(taskId)`, **Then** the task is deleted.
6. **Given** an agent wants to run a task immediately, **When** it calls `runTaskNow(taskId)`, **Then** the task executes right away.
7. **Given** an agent wants to update a task's schedule, **When** it calls `updateTaskSchedule(taskId, newSchedule)`, **Then** the schedule is updated.

### User Story 5 - Background daemon executes tasks (Priority: P1)

The scheduler daemon runs in the background, checking for due tasks and executing them by sending prompts to the selected agents.

**Acceptance Scenarios**:

1. **Given** a task is scheduled for a specific time, **When** that time arrives, **Then** the daemon executes the task by sending the prompt to the designated agent.
2. **Given** a recurring task, **When** it executes, **Then** the next run time is calculated and scheduled.
3. **Given** the daemon is running, **When** BOS starts, **Then** it loads all active tasks from storage and begins monitoring.
4. **Given** a task execution fails, **When** the error occurs, **Then** it is logged but does not crash the daemon; other tasks continue to execute.

### User Story 6 - Comprehensive logging (Priority: P2)

All scheduler activities are logged using BOS's central logging system for debugging and auditing.

**Acceptance Scenarios**:

1. **Given** a task is created, **When** it happens, **Then** a log entry is recorded with task details.
2. **Given** a task executes, **When** it runs (successfully or not), **Then** execution details are logged including timing and outcome.
3. **Given** a task is paused/resumed/deleted, **When** the action occurs, **Then** it is logged.
4. **Given** the daemon starts/stops, **When** the lifecycle event happens, **Then** it is logged to the supervisor log stream.

### User Story 7 - Task history and execution results (Priority: P2)

Users can view the history of task executions, including when they ran and their outcomes.

**Acceptance Scenarios**:

1. **Given** a task has executed multiple times, **When** the user views its details, **Then** they see a history of all executions with timestamps and status.
2. **Given** a task execution produced output, **When** viewing the history, **Then** the output or result summary is available.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The scheduler MUST support two schedule types:
  - **One-time**: Execute at a specific datetime
  - **Recurring**: Execute every N units (minutes, hours, days, weeks) with configurable interval
- **FR-002**: A **Task** entity MUST contain: `id`, `name`, `prompt` (the message to send), `agentId` (which agent receives it), `scheduleType` (one-time | recurring), `scheduleConfig` (datetime for one-time; interval + unit + optional start time for recurring), `status` (active | paused), `nextRunAt` (ISO timestamp or null if paused), `createdAt`, `updatedAt`.
- **FR-003**: The scheduler MUST persist tasks to a durable store (`data/scheduler/tasks.json`) so they survive restarts.
- **FR-004**: A **daemon process** MUST run in the background, checking for due tasks every minute (or configurable interval) and executing them by invoking the agent runtime.
- **FR-005**: The daemon MUST be resilient: task execution failures MUST NOT crash the daemon; errors MUST be logged and the daemon continues monitoring other tasks.
- **FR-006**: After a recurring task executes, the daemon MUST calculate and update the `nextRunAt` based on the interval.
- **FR-007**: One-time tasks that have executed MUST be marked as `completed` or removed (configurable).
- **FR-008**: The Scheduler app UI MUST display tasks sorted by `nextRunAt` (soonest first), with columns: Name, Agent, Next Run, Status, and actions (Run Now, Pause/Resume, Delete, Edit).
- **FR-009**: The UI MUST provide a "Schedule New Task" form with fields: name, prompt (textarea), agent selector, schedule type selector, and schedule-specific inputs.
- **FR-010**: The UI MUST allow editing existing tasks (name, prompt, schedule) while preserving execution history.
- **FR-011**: MCP tools MUST be provided for agents to interact with the scheduler:
  - `listScheduledTasks()` → returns all tasks with current state
  - `createTask(name, prompt, agentId, scheduleType, scheduleConfig)` → creates and returns task ID
  - `getTask(taskId)` → returns full task details including history
  - `updateTask(taskId, updates)` → updates mutable fields (name, prompt, schedule)
  - `pauseTask(taskId)` → sets status to paused
  - `resumeTask(taskId)` → sets status to active and calculates nextRunAt
  - `deleteTask(taskId)` → permanently removes the task
  - `runTaskNow(taskId)` → executes immediately regardless of schedule
  - `updateTaskSchedule(taskId, newScheduleConfig)` → updates just the schedule
- **FR-012**: All scheduler operations MUST log to BOS's central logging system using the `scheduler` component name, with appropriate levels (info for normal operations, warn for skipped tasks, error for failures).
- **FR-013**: Task execution MUST create a new conversation or append to an existing one (configurable per task) in the agent's chat history.
- **FR-014**: The daemon MUST start automatically when BOS starts (as part of the app installation), and MUST gracefully handle BOS shutdown.
- **FR-015**: Tasks MUST be loaded from storage on daemon startup, and any tasks with `nextRunAt` in the past (that weren't executed) MUST either be executed immediately or marked for review (configurable).

### Key Entities

- **Task** — the core entity containing all scheduling information.
- **ScheduleConfig** — varies by type: `{ type: 'one-time', datetime: ISO }` or `{ type: 'recurring', interval: number, unit: 'minute'|'hour'|'day'|'week', startTime?: ISO }`.
- **TaskExecution** — record of a task run: `{ taskId, executedAt, status: 'success'|'error', duration, output?, error? }`.
- **Daemon** — the background process that monitors and executes tasks.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can schedule a task via the assistant by having a natural conversation.
- **SC-002**: A user can schedule, view, pause, resume, delete, and manually trigger tasks via the UI.
- **SC-003**: An agent can fully manage scheduled tasks using the MCP tools.
- **SC-004**: Tasks execute at their scheduled times without manual intervention.
- **SC-005**: The daemon survives task execution errors and continues operating.
- **SC-006**: All scheduler activities are visible in the central logging system.
- **SC-007**: Tasks persist across BOS restarts and resume scheduling correctly.

## Assumptions & Dependencies

- Depends on the existing agent runtime being available to execute tasks (the agent can receive prompts and process them).
- Depends on BOS's central logging system (`017-central-logging`) for all log output.
- Depends on the app installation system (`009-installed-apps`) for deploying the scheduler as an installed app.
- The daemon runs as a background Node.js process within the BOS environment (similar to how other background services work).
- Task execution uses the existing MCP tool gateway or direct agent invocation (to be finalized in implementation).

## Design notes (non-normative)

**Architecture overview:**
```
┌─────────────────────────────────────────────────────────────┐
│                    Scheduler App                            │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │   Task UI   │  │  Task Store  │  │   MCP Tools       │  │
│  │  (React)    │  │  (data/)     │  │  (for agents)     │  │
│  └──────┬──────┘  └──────┬───────┘  └─────────┬─────────┘  │
│         │                │                    │            │
│         └────────────────┼────────────────────┘            │
│                          ▼                                 │
│              ┌─────────────────────┐                       │
│              │    Scheduler Daemon │                       │
│              │  (background loop)  │                       │
│              └──────────┬──────────┘                       │
└─────────────────────────┼──────────────────────────────────┘
                          │
                          ▼
              ┌─────────────────────┐
              │   Agent Runtime     │
              │  (execute prompts)  │
              └─────────────────────┘
```

**Storage layout:**
- `data/scheduler/tasks.json` — all tasks with their current state
- `data/scheduler/executions/` — per-task execution history files

**Daemon loop:**
1. Load tasks from storage
2. Check each active task: is `nextRunAt <= now`?
3. If yes, execute the task (send prompt to agent)
4. Update `nextRunAt` based on schedule type
5. Log the execution
6. Wait 60 seconds (or configured interval) and repeat

**Schedule calculation:**
- One-time: `nextRunAt = scheduled datetime`
- Recurring: `nextRunAt = lastExecution + (interval * unit)` or `startTime + (interval * unit)` for first run

**MCP tool implementation:**
- Tools are registered via the MCP gateway pattern (`014-mcp-tool-gateway`)
- The scheduler app registers as an MCP server exposing the task management tools
- Agents discover and call these tools through the standard gateway

**Logging integration:**
- All operations use the BOS logging service with `component: 'scheduler'`
- Execution results include timing, status, and any error details
- Daemon lifecycle events (start, stop, reload) are logged to supervisor stream

## Notes

- This feature complements the assistant by providing persistent task scheduling capabilities.
- The design follows BOS conventions for apps, logging, and MCP tool exposure.
- Future enhancements could include: cron-expression support, task dependencies, notifications, task templates.
