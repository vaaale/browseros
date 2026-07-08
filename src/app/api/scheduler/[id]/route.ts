import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logging";
import {
  deleteJob,
  getJob,
  listHistory,
  pauseJob,
  resumeJob,
  updateJob,
} from "@/lib/scheduler/engine";
import { getEditableFields, canPerformAction } from "@/lib/scheduler/acl";
import type {
  JobHandler,
  ScheduleConfig,
  UpdateJobInput,
} from "@/lib/scheduler/types";

export const dynamic = "force-dynamic";

// GET /api/scheduler/[id]        → job + history + editableFields + allowedActions
// PATCH /api/scheduler/[id]      → update mutable fields (ACL-gated in engine)
// DELETE /api/scheduler/[id]     → delete (rejected for system/integration)
// POST /api/scheduler/[id]       → { action: 'pause' | 'resume' }

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const history = await listHistory(id);
  return NextResponse.json({
    task: job,
    job,
    history,
    editableFields: getEditableFields(job),
    allowedActions: {
      runNow: canPerformAction(job, "run-now"),
      pause: canPerformAction(job, "pause"),
      resume: canPerformAction(job, "resume"),
      edit: canPerformAction(job, "edit"),
      delete: canPerformAction(job, "delete"),
    },
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const updates: UpdateJobInput = {};
  if (typeof body.name === "string") updates.name = body.name;
  if (typeof body.deleteAfterExecution === "boolean") {
    updates.deleteAfterExecution = body.deleteAfterExecution;
  }
  if (body.scheduleConfig && typeof body.scheduleConfig === "object") {
    updates.scheduleConfig = body.scheduleConfig as ScheduleConfig;
  }
  // Two ways to update the handler: full replacement, or the legacy
  // {prompt, agentId} pair from the UI. Both build a PromptHandler.
  if (body.handler && typeof body.handler === "object") {
    updates.handler = body.handler as JobHandler;
  } else if (typeof body.prompt === "string" || typeof body.agentId === "string") {
    const current = await getJob(id);
    if (!current) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    if (current.handler.kind !== "prompt") {
      return NextResponse.json(
        { error: "This job is not a prompt handler — pass a full handler object." },
        { status: 400 },
      );
    }
    updates.handler = {
      kind: "prompt",
      prompt: typeof body.prompt === "string" ? body.prompt : current.handler.prompt,
      agentId: typeof body.agentId === "string" ? body.agentId : current.handler.agentId,
    };
  }
  try {
    const job = await updateJob(id, updates);
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    logger().info("scheduler.api", "job updated", { id: job.id });
    return NextResponse.json({ task: job, job });
  } catch (err) {
    // ACL rejections and validation errors both come out here.
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const ok = await deleteJob(id);
    if (!ok) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    logger().info("scheduler.api", "job deleted", { id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 403 });
  }
}

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
    const job = await pauseJob(id);
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    logger().info("scheduler.api", "job paused", { id });
    return NextResponse.json({ task: job, job });
  }
  if (action === "resume") {
    const job = await resumeJob(id);
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    logger().info("scheduler.api", "job resumed", { id });
    return NextResponse.json({ task: job, job });
  }
  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}
