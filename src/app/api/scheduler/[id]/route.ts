import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logging";
import {
  deleteTask,
  getTask,
  listExecutions,
  pauseTask,
  resumeTask,
  updateTask,
} from "@/lib/scheduler/storage";
import type { ScheduleConfig, TaskUpdate } from "@/lib/scheduler/types";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  const history = await listExecutions(id);
  return NextResponse.json({ task, history });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const updates: TaskUpdate = {};
  if (typeof body.name === "string") updates.name = body.name;
  if (typeof body.prompt === "string") updates.prompt = body.prompt;
  if (typeof body.agentId === "string") updates.agentId = body.agentId;
  if (typeof body.deleteAfterExecution === "boolean") updates.deleteAfterExecution = body.deleteAfterExecution;
  if (body.scheduleConfig && typeof body.scheduleConfig === "object") {
    updates.scheduleConfig = body.scheduleConfig as ScheduleConfig;
  }
  try {
    const task = await updateTask(id, updates);
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    logger().info("scheduler.api", "task updated", { id: task.id });
    return NextResponse.json({ task });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ok = await deleteTask(id);
  if (!ok) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  logger().info("scheduler.api", "task deleted", { id });
  return NextResponse.json({ ok: true });
}

// Small helpers for pause / resume — mounted under /api/scheduler/[id]/action.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action = String(body.action ?? "");
  if (action === "pause") {
    const task = await pauseTask(id);
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    logger().info("scheduler.api", "task paused", { id });
    return NextResponse.json({ task });
  }
  if (action === "resume") {
    const task = await resumeTask(id);
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    logger().info("scheduler.api", "task resumed", { id });
    return NextResponse.json({ task });
  }
  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}
