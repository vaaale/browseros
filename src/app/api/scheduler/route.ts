import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logging";
import { createTask, listTasks } from "@/lib/scheduler/storage";
import { getDaemonStatus } from "@/lib/scheduler/daemon";
import type { ScheduleConfig, TaskInput } from "@/lib/scheduler/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const [tasks, daemon] = await Promise.all([listTasks(), Promise.resolve(getDaemonStatus())]);
  return NextResponse.json({ tasks, daemon });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const input = normalizeTaskInput(body);
  if (typeof input === "string") return NextResponse.json({ error: input }, { status: 400 });
  try {
    const task = await createTask(input);
    logger().info("scheduler.api", "task created", { id: task.id, name: task.name });
    return NextResponse.json({ task });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

// Shared normalization so the API and MCP tool paths accept the same body shape.
export function normalizeTaskInput(body: Record<string, unknown>): TaskInput | string {
  const name = String(body.name ?? "").trim();
  const prompt = String(body.prompt ?? "");
  const agentId = String(body.agentId ?? "").trim();
  if (!name) return "name is required";
  if (!prompt) return "prompt is required";
  if (!agentId) return "agentId is required";
  const cfg = body.scheduleConfig as ScheduleConfig | undefined;
  if (!cfg || typeof cfg !== "object") return "scheduleConfig is required";
  return {
    name,
    prompt,
    agentId,
    scheduleConfig: cfg,
    deleteAfterExecution: !!body.deleteAfterExecution,
  };
}
