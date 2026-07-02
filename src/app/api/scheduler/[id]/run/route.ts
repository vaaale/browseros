import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logging";
import { getTask } from "@/lib/scheduler/storage";
import { runTaskNow } from "@/lib/scheduler/daemon";

export const dynamic = "force-dynamic";
// A task's sub-agent run can take a while; keep the connection alive.
export const maxDuration = 600;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  logger().info("scheduler.api", "run now", { id, name: task.name });
  await runTaskNow(task);
  return NextResponse.json({ ok: true });
}
