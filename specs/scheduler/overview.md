# Scheduler App - Design Overview

This document provides a high-level overview of the Scheduler app design for BrowserOS.

## What is the Scheduler?

The Scheduler is a BrowserOS application that allows users to schedule tasks (prompts to agents) to run at specific times or on recurring intervals. It's similar to a cron job system but designed specifically for agent-based task execution.

## Core Concepts

### Task
A **Task** is the fundamental unit of scheduling. Each task consists of:
- **Name**: A human-readable identifier
- **Prompt**: The message/prompt to send to the agent
- **Agent**: Which agent should receive and execute the prompt
- **Schedule**: When the task should run (one-time or recurring)
- **Status**: Active, paused, or completed
- **Next Run**: When the task will next execute (null if paused)

### Schedule Types
1. **One-time**: Executes once at a specific date/time
2. **Recurring**: Executes repeatedly at regular intervals (every N minutes/hours/days/weeks)

### Daemon
A background process that:
- Runs continuously while BOS is active
- Checks for due tasks every 60 seconds
- Executes tasks by sending prompts to the designated agent
- Updates task state after execution
- Logs all activities

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         BrowserOS                               │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    Scheduler App                          │  │
│  │                                                           │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐  │  │
│  │  │   React     │  │  Task Store  │  │   MCP Server    │  │  │
│  │  │    UI       │  │  (data/)     │  │  (for agents)   │  │  │
│  │  └──────┬──────┘  └──────┬───────┘  └────────┬────────┘  │  │
│  │         │                │                   │           │  │
│  │         └────────────────┼───────────────────┘           │  │
│  │                          ▼                               │  │
│  │              ┌─────────────────────┐                     │  │
│  │              │   Daemon Process    │                     │  │
│  │              │  (background loop)  │                     │  │
│  │              └──────────┬──────────┘                     │  │
│  └─────────────────────────┼────────────────────────────────┘  │
│                            │                                    │
│                            ▼                                    │
│              ┌─────────────────────────────┐                    │
│              │      Agent Runtime          │                    │
│              │  (executes task prompts)    │                    │
│              └─────────────────────────────┘                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Core Library (`src/lib/scheduler/`)

**Types** (`types.ts`)
- TypeScript definitions for Task, ScheduleConfig, TaskExecution, etc.

**Storage** (`storage.ts`)
- Persists tasks to `data/scheduler/tasks.json`
- Stores execution history in `data/scheduler/executions/`
- Implements atomic writes to prevent corruption

**Task Service** (`task-service.ts`)
- CRUD operations for tasks
- Pause/resume functionality
- Task validation

**Schedule Engine** (`schedule.ts`)
- Calculates next run times
- Validates schedule configurations
- Handles timezone conversions

**Daemon** (`daemon.ts`)
- Background process loop
- Checks and executes due tasks
- Manages task lifecycle

**Executor** (`executor.ts`)
- Sends prompts to agents
- Captures execution results
- Measures execution time

**MCP Server** (`mcp-server.ts`)
- Exposes scheduler tools to agents
- Implements tool handlers
- Provides error responses

**Logger** (`logger.ts`)
- Integrates with BOS central logging
- Logs all scheduler activities

### 2. Scheduler App (`src/apps/scheduler/`)

**Main Components**
- `SchedulerApp.tsx` - Root component
- `TaskList.tsx` - Displays all tasks sorted by next run time
- `TaskForm.tsx` - Create/edit task form
- `TaskDetail.tsx` - Task details and execution history

**Features**
- View all scheduled tasks
- Create new tasks
- Edit existing tasks
- Pause/resume tasks
- Delete tasks
- Run tasks immediately
- View execution history

### 3. Assistant Integration

The assistant can interact with the scheduler through:
- Natural language detection ("I want to schedule a task")
- Guided conversation flow for task creation
- MCP tool usage for programmatic access

## Data Flow

### Creating a Task (via UI)
```
User → TaskForm → validate() → createTask() → storage.save() → Daemon detects new task
```

### Creating a Task (via Assistant)
```
User → Assistant → detect intent → gather info → MCP: createTask() → 
task-service.createTask() → storage.save() → confirmation to user
```

### Task Execution
```
Daemon loop → check due tasks → executeTask() → executor.sendPrompt(agent) → 
agent.process() → result captured → recordExecution() → update nextRunAt → log
```

### Modifying a Task
```
User/Agent → updateTask() → validate() → storage.save() → recalculate nextRunAt → 
daemon picks up changes on next loop
```

## User Workflows

### Workflow 1: Schedule via Assistant
1. User says "I want to schedule a task"
2. Assistant asks: "What would you like the task to do?"
3. User provides prompt (e.g., "Check for new emails and summarize")
4. Assistant asks: "Which agent should handle this?"
5. User selects an agent
6. Assistant asks: "When should it run? One-time or recurring?"
7. User chooses schedule type and provides details
8. Assistant creates the task via MCP tools
9. Assistant confirms: "Task 'Check emails' scheduled for [time]"

### Workflow 2: Schedule via UI
1. User opens Scheduler app
2. Clicks "Schedule New Task"
3. Fills in form:
   - Name: "Daily Backup"
   - Prompt: "Create a backup of all important files"
   - Agent: "Developer"
   - Schedule: Recurring, every 24 hours
4. Clicks "Save"
5. Task appears in the list with next run time

### Workflow 3: Manage Tasks
1. User opens Scheduler app
2. Sees list of all tasks sorted by next run time
3. Can:
   - Click "Run Now" to execute immediately
   - Click "Pause" to temporarily disable
   - Click "Resume" to re-enable
   - Click "Edit" to modify task details
   - Click "Delete" to remove permanently
   - View execution history for each task

### Workflow 4: Agent Creates Task
1. User asks agent: "Schedule a daily report at 9 AM"
2. Agent uses MCP tools:
   - `createTask("Daily Report", "Generate daily summary...", "Assistant", "recurring", {...})`
3. Task is created and appears in scheduler
4. Agent confirms creation to user

## Configuration

### Storage Location
- Tasks: `data/scheduler/tasks.json`
- Executions: `data/scheduler/executions/<taskId>.json`

### Daemon Settings
- Check interval: 60 seconds (configurable)
- Past-due handling: Execute immediately or mark for review (configurable)

### Logging
- Component name: `scheduler`
- Log levels: info, warn, error
- Integrated with BOS central logging system

## Security Considerations

1. **Agent Access**: Tasks run as the specified agent, inheriting its permissions
2. **Prompt Validation**: Prompts are validated to prevent injection attacks
3. **Storage Security**: Data is stored in user's sandboxed data directory
4. **MCP Tool Scoping**: Tools can be restricted per-agent (via `011-per-agent-capabilities`)

## Error Handling

### Task Execution Errors
- Caught and logged
- Don't crash the daemon
- Recorded in execution history with error details
- Daemon continues to process other tasks

### Storage Errors
- Retried with exponential backoff
- Logged as errors
- User notified via UI if critical

### Schedule Calculation Errors
- Invalid schedules are rejected at creation time
- Clear error messages guide user to valid input

## Performance Considerations

1. **Task Checking**: Daemon skips paused/completed tasks efficiently
2. **Storage**: Atomic writes prevent corruption but add slight overhead
3. **Execution History**: Lazy-loaded in UI to avoid large payloads
4. **MCP Tools**: Cached tool schemas for faster discovery

## Future Enhancements

### Potential Features (Not in v1)
- Cron expression support for complex schedules
- Task dependencies (B runs after A completes)
- Notifications when tasks complete
- Task templates for common patterns
- Task grouping/categorization
- Export/import task configurations
- Webhook integrations
- Task retry policies
- Parallel task execution limits

### Scalability Improvements
- Database backend for very large task counts
- Distributed daemon for multi-instance deployments
- Priority queues for time-sensitive tasks

## Dependencies

### Core BOS Features
- **Agent Runtime**: For executing task prompts
- **Central Logging** (`017`): For all log output
- **MCP Gateway** (`014`): For agent tool access
- **Per-Agent Capabilities** (`011`): For tool scoping
- **Installed Apps** (`009`): For app deployment

### External Dependencies
- Node.js built-ins only (no external packages)
- Uses existing BOS infrastructure

## Testing Strategy

### Unit Tests
- Schedule calculation logic
- Task CRUD operations
- Storage operations
- Validation logic

### Integration Tests
- End-to-end task lifecycle
- Daemon execution flow
- MCP tool interactions
- Error handling scenarios

### Manual Testing
- Create tasks via UI and assistant
- Verify execution at scheduled times
- Test all management operations
- Validate logging output

## Success Criteria

The Scheduler is successful when:
1. ✅ Users can schedule tasks via natural language with the assistant
2. ✅ Users can manage tasks through a clear, intuitive UI
3. ✅ Agents can programmatically create and manage tasks
4. ✅ Tasks execute reliably at their scheduled times
5. ✅ The system is resilient to errors and restarts
6. ✅ All activities are logged for debugging and auditing

## Related Specifications

- `000-browseros-core`: Core BOS architecture
- `009-installed-apps`: App installation and structure
- `011-per-agent-capabilities`: Agent tool scoping
- `014-mcp-tool-gateway`: MCP tool exposure pattern
- `017-central-logging`: Logging system integration

## Glossary

- **Task**: A scheduled prompt to be sent to an agent
- **Daemon**: The background process that monitors and executes tasks
- **Schedule**: When and how often a task should run
- **Execution**: One instance of a task running
- **Next Run**: The calculated time when a task will next execute
- **MCP Tool**: A function exposed to agents via the Model Context Protocol
