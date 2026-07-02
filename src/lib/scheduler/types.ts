// Scheduler types shared between server and client. Framework-free — no Node
// or React imports so it is safe on either side.

export type ScheduleType = "one-time" | "recurring";
export type RecurringUnit = "minute" | "hour" | "day" | "week";
export type TaskStatus = "active" | "paused" | "completed";
export type ExecutionStatus = "success" | "error";

export interface OneTimeSchedule {
  type: "one-time";
  datetime: string;
}

export interface RecurringSchedule {
  type: "recurring";
  interval: number;
  unit: RecurringUnit;
  startTime?: string;
}

export type ScheduleConfig = OneTimeSchedule | RecurringSchedule;

export interface TaskExecution {
  id: string;
  taskId: string;
  executedAt: string;
  status: ExecutionStatus;
  duration: number;
  output?: string;
  error?: string;
}

export interface Task {
  id: string;
  name: string;
  prompt: string;
  agentId: string;
  scheduleType: ScheduleType;
  scheduleConfig: ScheduleConfig;
  status: TaskStatus;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastExecutedAt?: string;
  deleteAfterExecution?: boolean;
}

export interface TaskWithHistory extends Task {
  executionHistory: TaskExecution[];
}

export interface TaskInput {
  name: string;
  prompt: string;
  agentId: string;
  scheduleConfig: ScheduleConfig;
  deleteAfterExecution?: boolean;
}

export interface TaskUpdate {
  name?: string;
  prompt?: string;
  agentId?: string;
  scheduleConfig?: ScheduleConfig;
  deleteAfterExecution?: boolean;
}
