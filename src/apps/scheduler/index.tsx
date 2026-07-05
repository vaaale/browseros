"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CalendarX,
  Check,
  Clock,
  Filter,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash,
  X,
} from "lucide-react";
import type {
  JobCategory,
  JobDefinition,
  JobExecution,
  RecurringUnit,
  ScheduleConfig,
} from "@/lib/scheduler/types";
import { describeSchedule } from "@/lib/scheduler/schedule";

// UI-local aliases so the diff from the legacy Task naming stays small. The
// runtime shape is JobDefinition (with a nested handler); the UI derives the
// prompt/agentId it displays from `job.handler` when the kind is 'prompt'.
type Task = JobDefinition;
type TaskExecution = JobExecution;

interface AllowedActions {
  runNow: boolean;
  pause: boolean;
  resume: boolean;
  edit: boolean;
  delete: boolean;
}

// Category → pill styling. Kept in one place so the badge/tooltip stay in sync.
const CATEGORY_BADGE: Record<JobCategory, { label: string; className: string; hint: string }> = {
  user: {
    label: "User",
    className: "bg-violet-500/20 text-violet-200",
    hint: "User-created job — full control.",
  },
  system: {
    label: "System",
    className: "bg-sky-500/20 text-sky-200",
    hint: "Owned by a BrowserOS subsystem. Interval editable; delete disabled.",
  },
  integration: {
    label: "Integration",
    className: "bg-amber-500/20 text-amber-200",
    hint: "Owned by an installed integration. Handler read-only; delete via uninstall.",
  },
};

// Front-end mirror of getEditableFields/canPerformAction (see lib/scheduler/acl.ts).
// The server is still the source of truth — this is just so we can grey buttons
// out without an extra round-trip per row.
function localAllowedActions(job: JobDefinition): AllowedActions {
  if (job.category === "user") {
    return { runNow: true, pause: true, resume: true, edit: true, delete: true };
  }
  return { runNow: true, pause: true, resume: true, edit: true, delete: false };
}

function canEditHandler(job: JobDefinition): boolean {
  return job.category === "user" && !(job.readOnlyFields ?? []).includes("handler");
}

// Extract the human-readable "who does this run against" for the row. Prompt
// jobs show the agent; internal shows the ref; integration shows the target.
function handlerLabel(job: JobDefinition): string {
  if (job.handler.kind === "prompt") return job.handler.agentId;
  if (job.handler.kind === "internal") return job.handler.ref;
  return `${job.handler.integrationId}:${job.handler.action}`;
}

// All text worth matching against the search box — prompt body for prompt jobs,
// handler ref for internal, integration target for integration polls.
function searchableText(job: JobDefinition): string {
  if (job.handler.kind === "prompt") return job.handler.prompt.toLowerCase();
  if (job.handler.kind === "internal") return job.handler.ref.toLowerCase();
  return `${job.handler.integrationId} ${job.handler.action}`.toLowerCase();
}

interface AgentOption {
  id: string;
  name: string;
  type: string;
  description: string;
}

interface DaemonStatus {
  running: boolean;
  lastCheck: number | null;
  tickMs: number;
}

// Agent-badge colors picked deterministically from the id so the same agent
// always renders with the same colour, without hard-coding names.
const BADGE_PALETTE = [
  "bg-violet-500/20 text-violet-200",
  "bg-sky-500/20 text-sky-200",
  "bg-emerald-500/20 text-emerald-200",
  "bg-amber-500/20 text-amber-200",
  "bg-rose-500/20 text-rose-200",
  "bg-cyan-500/20 text-cyan-200",
  "bg-fuchsia-500/20 text-fuchsia-200",
];

function agentBadgeClass(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return BADGE_PALETTE[Math.abs(h) % BADGE_PALETTE.length];
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.parse(iso) - Date.now();
  const abs = Math.abs(diff);
  const past = diff < 0;
  const s = Math.floor(abs / 1000);
  if (s < 60) return past ? `${s}s ago` : `In ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return past ? `${m}m ago` : `In ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return past ? `${h}h ${m % 60}m ago` : `In ${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return past ? `${d}d ago` : `In ${d}d`;
}

function formatTs(ts: number | null): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
  return `${Math.floor(diff / 60_000)}m ago`;
}

export default function SchedulerApp() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [daemon, setDaemon] = useState<DaemonStatus | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "paused" | "completed">("all");
  const [editing, setEditing] = useState<Task | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [detailTask, setDetailTask] = useState<Task | null>(null);
  const [detailHistory, setDetailHistory] = useState<TaskExecution[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Force relative-time re-render every 15s without refetching.
  const [, setTick] = useState(0);

  const loadTasks = useCallback(async () => {
    try {
      const res = await fetch("/api/scheduler");
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { tasks: Task[]; daemon: DaemonStatus };
      setTasks(data.tasks);
      setDaemon(data.daemon);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadTasks();
    fetch("/api/scheduler/agents")
      .then((r) => r.json())
      .then((d) => setAgents(d.agents ?? []))
      .catch(() => {});
    const poll = setInterval(loadTasks, 10_000);
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => {
      clearInterval(poll);
      clearInterval(t);
    };
  }, [loadTasks]);

  const openNew = () => {
    setEditing(null);
    setShowModal(true);
  };

  const openEdit = (task: Task) => {
    setEditing(task);
    setShowModal(true);
  };

  const openDetail = async (task: Task) => {
    setDetailTask(task);
    const res = await fetch(`/api/scheduler/${task.id}`);
    if (res.ok) {
      const data = (await res.json()) as { history: TaskExecution[] };
      setDetailHistory(data.history);
    }
  };

  const runNow = async (task: Task) => {
    console.log("Running job now:", task.id);
    const res = await fetch(`/api/scheduler/${task.id}/run`, { method: "POST" });
    console.log("Response status:", res.status);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      setError(`Run failed (${res.status}): ${body || res.statusText}`);
      return;
    }
    await loadTasks();
  };

  const pauseResume = async (task: Task) => {
    await fetch(`/api/scheduler/${task.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: task.status === "paused" ? "resume" : "pause" }),
    });
    void loadTasks();
  };

  const remove = async (task: Task) => {
    if (!confirm(`Delete task "${task.name}"?`)) return;
    await fetch(`/api/scheduler/${task.id}`, { method: "DELETE" });
    void loadTasks();
  };

  const stats = useMemo(() => {
    const active = tasks.filter((t) => t.status === "active").length;
    const paused = tasks.filter((t) => t.status === "paused").length;
    const completed = tasks.filter((t) => t.status === "completed").length;
    const next = tasks
      .filter((t) => t.status === "active" && t.nextRunAt)
      .sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!))[0];
    return { active, paused, completed, next: next?.nextRunAt ?? null };
  }, [tasks]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tasks
      .filter((t) => statusFilter === "all" || t.status === statusFilter)
      .filter((t) => !q || t.name.toLowerCase().includes(q) || searchableText(t).includes(q))
      .slice()
      .sort((a, b) => {
        // active tasks with a nextRunAt first, sorted by soonest; then paused, then completed.
        const order = (t: Task) => (t.status === "active" ? 0 : t.status === "paused" ? 1 : 2);
        if (order(a) !== order(b)) return order(a) - order(b);
        const at = a.nextRunAt ? Date.parse(a.nextRunAt) : Number.POSITIVE_INFINITY;
        const bt = b.nextRunAt ? Date.parse(b.nextRunAt) : Number.POSITIVE_INFINITY;
        return at - bt;
      });
  }, [tasks, search, statusFilter]);

  const agentById = useMemo(() => {
    const m = new Map<string, AgentOption>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

  return (
    <div className="flex h-full flex-col bg-[#0f1117] text-white" data-theme="dark">
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 bg-white/5 px-4 py-3">
        <div className="flex items-center gap-3">
          <CalendarClock size={20} className="text-violet-300" />
          <h1 className="text-base font-semibold text-white">Scheduler</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={openNew}
            className="flex items-center gap-1.5 rounded bg-violet-500/30 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-violet-500/40"
          >
            <Plus size={14} />
            Schedule New Task
          </button>
        </div>
      </div>

      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-400/20 bg-amber-400/10 px-4 py-2 text-xs text-amber-100">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="rounded p-1 hover:bg-white/10">
            <X size={12} />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mb-4 grid grid-cols-4 gap-3">
          <StatCard label="Active" value={String(stats.active)} accent="text-white" />
          <StatCard label="Paused" value={String(stats.paused)} accent="text-white/70" />
          <StatCard label="Completed" value={String(stats.completed)} accent="text-emerald-300" />
          <StatCard
            label="Next Run"
            value={stats.next ? formatRelative(stats.next) : "—"}
            accent="text-violet-300"
            small
          />
        </div>

        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-white/50">Scheduled Tasks</h2>
          <div className="flex items-center gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tasks..."
              className="w-48 rounded border border-white/10 bg-black/30 px-2 py-1 text-xs outline-none focus:border-white/30"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              className="rounded border border-white/10 bg-black/30 px-2 py-1 text-xs outline-none focus:border-white/30"
            >
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="completed">Completed</option>
            </select>
            <span className="rounded p-1.5 text-white/40" title="Filter">
              <Filter size={14} />
            </span>
          </div>
        </div>

        {tasks.length === 0 ? (
          <EmptyState onCreate={openNew} />
        ) : filtered.length === 0 ? (
          <div className="rounded-lg border border-white/10 bg-white/[0.02] p-8 text-center text-sm text-white/50">
            No tasks match your filters.
          </div>
        ) : (
          <TaskTable
            tasks={filtered}
            agentById={agentById}
            onRunNow={runNow}
            onPauseResume={pauseResume}
            onEdit={openEdit}
            onDelete={remove}
            onOpenDetail={openDetail}
          />
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-white/10 bg-white/[0.02] px-4 py-2 text-xs">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span
              className={`h-2 w-2 rounded-full ${
                daemon?.running ? "animate-pulse bg-emerald-400" : "bg-white/30"
              }`}
            />
            <span className="text-white/60">{daemon?.running ? "Daemon running" : "Daemon idle"}</span>
          </span>
          <span className="text-white/40">Last check: {formatTs(daemon?.lastCheck ?? null)}</span>
        </div>
        <div className="flex items-center gap-3 text-white/40">
          <span>Total tasks: {tasks.length}</span>
        </div>
      </div>

      {showModal && (
        <TaskModal
          initial={editing}
          agents={agents}
          onClose={() => setShowModal(false)}
          onSaved={() => {
            setShowModal(false);
            void loadTasks();
          }}
        />
      )}

      {detailTask && (
        <TaskDetailModal
          task={detailTask}
          history={detailHistory}
          agentName={agentLabelFor(detailTask, agentById)}
          onClose={() => {
            setDetailTask(null);
            setDetailHistory([]);
          }}
          onEdit={() => {
            setEditing(detailTask);
            setDetailTask(null);
            setDetailHistory([]);
            setShowModal(true);
          }}
        />
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
  small,
}: {
  label: string;
  value: string;
  accent: string;
  small?: boolean;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-3">
      <div className="text-xs text-white/50">{label}</div>
      <div className={`mt-1 font-semibold ${small ? "text-sm" : "text-2xl"} ${accent}`}>{value}</div>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <CalendarX size={48} className="mb-4 text-white/20" />
      <h3 className="text-base font-medium text-white/70">No scheduled tasks</h3>
      <p className="mt-1 text-sm text-white/40">Create your first scheduled task to get started.</p>
      <button
        onClick={onCreate}
        className="mt-4 flex items-center gap-2 rounded bg-violet-500/30 px-4 py-2 text-sm font-medium transition-colors hover:bg-violet-500/40"
      >
        <Plus size={16} />
        Schedule New Task
      </button>
    </div>
  );
}

function TaskTable({
  tasks,
  agentById,
  onRunNow,
  onPauseResume,
  onEdit,
  onDelete,
  onOpenDetail,
}: {
  tasks: Task[];
  agentById: Map<string, AgentOption>;
  onRunNow: (task: Task) => void;
  onPauseResume: (task: Task) => void;
  onEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
  onOpenDetail: (task: Task) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.02]">
      <table className="w-full text-left">
        <thead className="border-b border-white/10 bg-white/[0.03]">
          <tr>
            <Th>Name</Th>
            <Th>Category</Th>
            <Th>Target</Th>
            <Th>Schedule</Th>
            <Th>Last / Next</Th>
            <Th>Status</Th>
            <Th align="right">Actions</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              agentName={agentLabelFor(task, agentById)}
              onRunNow={onRunNow}
              onPauseResume={onPauseResume}
              onEdit={onEdit}
              onDelete={onDelete}
              onOpenDetail={onOpenDetail}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      className={`px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-white/40 ${
        align === "right" ? "text-right" : ""
      }`}
    >
      {children}
    </th>
  );
}

function TaskRow({
  task,
  agentName,
  onRunNow,
  onPauseResume,
  onEdit,
  onDelete,
  onOpenDetail,
}: {
  task: Task;
  agentName: string;
  onRunNow: (task: Task) => void;
  onPauseResume: (task: Task) => void;
  onEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
  onOpenDetail: (task: Task) => void;
}) {
  const paused = task.status === "paused";
  const completed = task.status === "completed";
  return (
    <tr
      className={`group transition-colors hover:bg-white/5 ${paused ? "bg-white/[0.02] opacity-70" : ""}`}
    >
      <td className="px-4 py-3">
        <button
          onClick={() => onOpenDetail(task)}
          className="flex items-center gap-2 text-left"
          title="View task details"
        >
          <Clock size={14} className={completed ? "text-emerald-400" : "text-white/40"} />
          <span className={`text-sm font-medium ${paused ? "text-white/60" : "text-white"}`}>
            {task.name}
          </span>
        </button>
      </td>
      <td className="px-4 py-3">
        <CategoryBadge category={task.category} />
      </td>
      <td className="px-4 py-3">
        <span className={`rounded px-2 py-0.5 text-xs ${agentBadgeClass(handlerLabel(task))}`}>
          {agentName}
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="text-xs text-white/60">{task.scheduleType === "one-time" ? "One-time" : "Recurring"}</div>
        <div className="text-xs text-white/40">{describeSchedule(task.scheduleConfig)}</div>
      </td>
      <td className="px-4 py-3">
        {completed ? (
          <div className="text-sm font-medium text-white/50">Completed</div>
        ) : paused ? (
          <div className="text-sm font-medium text-white/40">Paused</div>
        ) : (
          <div className={`text-sm font-medium ${overdueClass(task.nextRunAt)}`}>
            {formatRelative(task.nextRunAt)}
          </div>
        )}
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={task.status} />
      </td>
      <td className="px-4 py-3 text-right">
        <RowActions
          task={task}
          onRunNow={onRunNow}
          onPauseResume={onPauseResume}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </td>
    </tr>
  );
}

function RowActions({
  task,
  onRunNow,
  onPauseResume,
  onEdit,
  onDelete,
}: {
  task: Task;
  onRunNow: (task: Task) => void;
  onPauseResume: (task: Task) => void;
  onEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
}) {
  const paused = task.status === "paused";
  const completed = task.status === "completed";
  const allowed = localAllowedActions(task);
  return (
    <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      {!completed && allowed.runNow && (
        <IconButton onClick={() => onRunNow(task)} title="Run Now">
          <Play size={14} />
        </IconButton>
      )}
      {!completed && (paused ? allowed.resume : allowed.pause) && (
        <IconButton onClick={() => onPauseResume(task)} title={paused ? "Resume" : "Pause"}>
          {paused ? <Play size={14} /> : <Pause size={14} />}
        </IconButton>
      )}
      {allowed.edit && (
        <IconButton onClick={() => onEdit(task)} title="Edit">
          <Pencil size={14} />
        </IconButton>
      )}
      {allowed.delete ? (
        <IconButton onClick={() => onDelete(task)} title="Delete" danger>
          <Trash size={14} />
        </IconButton>
      ) : (
        <span
          className="rounded p-1.5 text-white/20"
          title={`Delete is disabled for ${task.category} jobs — managed by ${task.owner ?? task.category}.`}
        >
          <Trash size={14} />
        </span>
      )}
    </div>
  );
}

function CategoryBadge({ category }: { category: JobCategory }) {
  const cfg = CATEGORY_BADGE[category];
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs ${cfg.className}`}
      title={cfg.hint}
    >
      {cfg.label}
    </span>
  );
}

function agentLabelFor(job: Task, agentById: Map<string, AgentOption>): string {
  if (job.handler.kind === "prompt") {
    return agentById.get(job.handler.agentId)?.name ?? job.handler.agentId;
  }
  return handlerLabel(job);
}

function overdueClass(iso: string | null): string {
  if (!iso) return "text-white/60";
  const diff = Date.parse(iso) - Date.now();
  if (diff < 60_000 && diff > -60_000) return "text-emerald-300";
  return "text-white/70";
}

function StatusBadge({ status }: { status: Task["status"] }) {
  if (status === "active") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-200">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        Active
      </span>
    );
  }
  if (status === "paused") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-white/10 px-2 py-0.5 text-xs text-white/50">
        <span className="h-1.5 w-1.5 rounded-full bg-white/40" />
        Paused
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-200">
      <Check size={10} />
      Done
    </span>
  );
}

function IconButton({
  children,
  onClick,
  title,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`rounded p-1.5 ${danger ? "text-red-300 hover:bg-red-500/20" : "hover:bg-white/10"}`}
    >
      {children}
    </button>
  );
}

function TaskModal({
  initial,
  agents,
  onClose,
  onSaved,
}: {
  initial: Task | null;
  agents: AgentOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  // Only 'prompt' handlers are user-editable via this modal. Non-prompt jobs
  // (internal system loops, integration polls) fall back to schedule-only
  // editing — their prompt/target fields are locked at seed time.
  const initialPrompt =
    initial && initial.handler.kind === "prompt" ? initial.handler.prompt : "";
  const initialAgentId =
    initial && initial.handler.kind === "prompt" ? initial.handler.agentId : "";
  const category = initial?.category ?? "user";
  const canEditPrompt = !initial || (initial && canEditHandler(initial));

  const [name, setName] = useState(initial?.name ?? "");
  const [prompt, setPrompt] = useState(initialPrompt);
  const [agentId, setAgentId] = useState(initialAgentId || agents[0]?.id || "");
  const [scheduleType, setScheduleType] = useState<"one-time" | "recurring">(
    initial?.scheduleType ?? "one-time",
  );
  const [datetime, setDatetime] = useState<string>(() => {
    if (initial?.scheduleConfig.type === "one-time") return toInputDatetime(initial.scheduleConfig.datetime);
    return toInputDatetime(new Date(Date.now() + 5 * 60_000).toISOString());
  });
  const [interval, setIntervalValue] = useState<number>(
    initial?.scheduleConfig.type === "recurring" ? initial.scheduleConfig.interval : 1,
  );
  const [unit, setUnit] = useState<RecurringUnit>(
    initial?.scheduleConfig.type === "recurring" ? initial.scheduleConfig.unit : "hour",
  );
  const [startTime, setStartTime] = useState<string>(() => {
    if (initial?.scheduleConfig.type === "recurring" && initial.scheduleConfig.startTime) {
      return toInputDatetime(initial.scheduleConfig.startTime);
    }
    return "";
  });
  const [deleteAfter, setDeleteAfter] = useState<boolean>(!!initial?.deleteAfterExecution);
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!agentId && agents.length > 0) setAgentId(agents[0].id);
  }, [agentId, agents]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalError(null);
    let scheduleConfig: ScheduleConfig;
    if (scheduleType === "one-time") {
      const iso = fromInputDatetime(datetime);
      if (!iso) {
        setModalError("Please pick a valid date and time.");
        return;
      }
      scheduleConfig = { type: "one-time", datetime: iso };
    } else {
      const iv = Number(interval);
      if (!Number.isFinite(iv) || iv < 1) {
        setModalError("Interval must be at least 1.");
        return;
      }
      scheduleConfig = {
        type: "recurring",
        interval: iv,
        unit,
        ...(startTime ? { startTime: fromInputDatetime(startTime) ?? undefined } : {}),
      };
    }
    setSaving(true);
    try {
      const url = initial ? `/api/scheduler/${initial.id}` : "/api/scheduler";
      const method = initial ? "PATCH" : "POST";
      // Send only what the ACL permits. For system/integration jobs on edit,
      // that's essentially just the schedule; sending name/prompt/agentId would
      // be rejected by the server anyway.
      const body: Record<string, unknown> = { scheduleConfig };
      if (!initial || canEditPrompt) {
        body.name = name;
        body.prompt = prompt;
        body.agentId = agentId;
        body.deleteAfterExecution = scheduleType === "one-time" ? deleteAfter : false;
      }
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Save failed" }));
        throw new Error(data.error ?? "Save failed");
      }
      onSaved();
    } catch (err) {
      setModalError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-base font-semibold text-white">
          {initial ? "Edit Task" : "Schedule New Task"}
        </h3>
        <button onClick={onClose} className="rounded p-1 transition-colors hover:bg-white/10">
          <X size={18} />
        </button>
      </div>

      <form onSubmit={submit} className="space-y-4">
        {initial && category !== "user" && (
          <div className="rounded border border-white/10 bg-white/[0.03] p-3 text-xs text-white/60">
            <span className="mr-2 font-medium text-white/80">{CATEGORY_BADGE[category].label} job</span>
            {CATEGORY_BADGE[category].hint}
          </div>
        )}

        <Field label="Task Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Daily Backup"
            className="w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-white/30 disabled:opacity-60"
            required
            disabled={!!initial && !canEditPrompt}
          />
        </Field>

        <Field label="Prompt">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder={
              initial && initial.handler.kind !== "prompt"
                ? `Handler: ${initial.handler.kind} (${handlerLabel(initial)})`
                : "Enter the message to send to the agent..."
            }
            className="w-full resize-none rounded border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm outline-none focus:border-white/30 disabled:opacity-60"
            required={!initial || canEditPrompt}
            disabled={!!initial && !canEditPrompt}
          />
        </Field>

        <Field label="Agent">
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-white/30 disabled:opacity-60"
            required={!initial || canEditPrompt}
            disabled={!!initial && !canEditPrompt}
          >
            {agents.length === 0 && <option value="">No agents available</option>}
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Schedule Type">
          <div className="flex gap-2">
            <RadioTile
              label="One-time"
              checked={scheduleType === "one-time"}
              onChange={() => setScheduleType("one-time")}
            />
            <RadioTile
              label="Recurring"
              checked={scheduleType === "recurring"}
              onChange={() => setScheduleType("recurring")}
            />
          </div>
        </Field>

        {scheduleType === "one-time" ? (
          <Field label="Date & Time">
            <input
              type="datetime-local"
              value={datetime}
              onChange={(e) => setDatetime(e.target.value)}
              className="w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/80 outline-none focus:border-white/30"
              required
            />
          </Field>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Interval">
                <input
                  type="number"
                  min={1}
                  value={interval}
                  onChange={(e) => setIntervalValue(Number(e.target.value))}
                  className="w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-white/30"
                />
              </Field>
              <Field label="Unit">
                <select
                  value={unit}
                  onChange={(e) => setUnit(e.target.value as RecurringUnit)}
                  className="w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-white/30"
                >
                  <option value="minute">Minutes</option>
                  <option value="hour">Hours</option>
                  <option value="day">Days</option>
                  <option value="week">Weeks</option>
                </select>
              </Field>
            </div>
            <Field label="Start Time (optional)">
              <input
                type="datetime-local"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="w-full rounded border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/80 outline-none focus:border-white/30"
              />
              <p className="mt-1 text-xs text-white/40">Defaults to immediately if not set.</p>
            </Field>
          </div>
        )}

        {scheduleType === "one-time" && (
          <div className="rounded border border-white/10 bg-white/[0.02] p-3">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={deleteAfter}
                onChange={(e) => setDeleteAfter(e.target.checked)}
                className="accent-violet-400"
              />
              <span className="text-xs text-white/70">Delete after execution</span>
            </label>
          </div>
        )}

        {modalError && (
          <div className="flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-200">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{modalError}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-white/10 px-4 py-2 text-sm transition-colors hover:bg-white/20"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded bg-violet-500/30 px-4 py-2 text-sm font-medium transition-colors hover:bg-violet-500/40 disabled:opacity-50"
          >
            {saving ? "Saving…" : initial ? "Save Changes" : "Create Task"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-white/70">{label}</label>
      {children}
    </div>
  );
}

function RadioTile({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label
      className={`flex flex-1 cursor-pointer items-center gap-2 rounded border px-3 py-2 hover:bg-white/5 ${
        checked ? "border-violet-400/60 bg-violet-500/10" : "border-white/10 bg-black/30"
      }`}
    >
      <input type="radio" checked={checked} onChange={onChange} className="accent-violet-400" />
      <span className="text-sm text-white/80">{label}</span>
    </label>
  );
}

function TaskDetailModal({
  task,
  history,
  agentName,
  onClose,
  onEdit,
}: {
  task: Task;
  history: TaskExecution[];
  agentName: string;
  onClose: () => void;
  onEdit: () => void;
}) {
  const sorted = [...history].sort((a, b) => Date.parse(b.executedAt) - Date.parse(a.executedAt));
  return (
    <ModalShell onClose={onClose} width={640}>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-base font-semibold text-white">Task Details</h3>
        <button onClick={onClose} className="rounded p-1 transition-colors hover:bg-white/10">
          <X size={18} />
        </button>
      </div>
      <div className="mb-6 space-y-3">
        <Row label="Name" value={<span className="text-sm font-medium text-white">{task.name}</span>} />
        <Row label="Category" value={<CategoryBadge category={task.category} />} />
        <Row
          label={task.handler.kind === "prompt" ? "Agent" : "Handler"}
          value={
            <span className={`inline-block rounded px-2 py-0.5 text-xs ${agentBadgeClass(handlerLabel(task))}`}>
              {agentName}
            </span>
          }
        />
        <Row
          label="Schedule"
          value={
            <span className="text-sm text-white/70">
              {task.scheduleType === "one-time" ? "One-time" : "Recurring"} · {describeSchedule(task.scheduleConfig)}
            </span>
          }
        />
        <Row
          label="Next Run"
          value={
            task.status === "paused" ? (
              <span className="text-sm font-medium text-white/40">Paused</span>
            ) : task.status === "completed" ? (
              <span className="text-sm font-medium text-white/50">Completed</span>
            ) : (
              <span className="text-sm font-medium text-emerald-300">{formatRelative(task.nextRunAt)}</span>
            )
          }
        />
        <Row label="Status" value={<StatusBadge status={task.status} />} />
      </div>
      <div className="mb-6">
        <label className="mb-1.5 block text-xs font-medium text-white/70">
          {task.handler.kind === "prompt" ? "Prompt" : "Handler"}
        </label>
        <div className="max-h-32 overflow-auto rounded border border-white/10 bg-black/30 p-3 font-mono text-sm text-white/80">
          {task.handler.kind === "prompt"
            ? task.handler.prompt
            : task.handler.kind === "internal"
              ? `internal:${task.handler.ref}`
              : `integration:${task.handler.integrationId}/${task.handler.action}`}
        </div>
      </div>
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">Execution History</h4>
        <div className="overflow-hidden rounded border border-white/10 bg-white/[0.02]">
          <table className="w-full text-left">
            <thead className="border-b border-white/10 bg-white/[0.03]">
              <tr>
                <Th>Executed</Th>
                <Th>Status</Th>
                <Th>Duration</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-4 text-center text-xs text-white/40">
                    No executions yet.
                  </td>
                </tr>
              )}
              {sorted.map((exec) => (
                <tr key={exec.id}>
                  <td className="px-3 py-2 text-xs text-white/70">
                    {new Date(exec.executedAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    {exec.status === "success" ? (
                      <span className="inline-flex items-center gap-1 rounded bg-emerald-500/20 px-1.5 py-0.5 text-xs text-emerald-200">
                        <Check size={10} />
                        Success
                      </span>
                    ) : (
                      <span
                        className="inline-flex items-center gap-1 rounded bg-red-500/20 px-1.5 py-0.5 text-xs text-red-200"
                        title={exec.error ?? ""}
                      >
                        <X size={10} />
                        Error
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-white/50">
                    {(exec.duration / 1000).toFixed(1)}s
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="mt-6 flex items-center justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded bg-white/10 px-3 py-1.5 text-xs transition-colors hover:bg-white/20"
        >
          Close
        </button>
        <button
          onClick={onEdit}
          className="rounded bg-violet-500/30 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-violet-500/40"
        >
          Edit Task
        </button>
      </div>
    </ModalShell>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3">
      <span className="text-xs text-white/50">{label}</span>
      {value}
    </div>
  );
}

function ModalShell({
  children,
  onClose,
  width = 520,
}: {
  children: React.ReactNode;
  onClose: () => void;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[200000] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="max-h-[92vh] overflow-auto rounded-2xl border border-white/10 bg-[#15171e] p-6 text-sm shadow-2xl"
        style={{ width, maxWidth: "92vw" }}
      >
        {children}
      </div>
    </div>
  );
}

// datetime-local inputs use local timezone strings without seconds; convert to
// and from ISO strings for the API.
function toInputDatetime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

function fromInputDatetime(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
