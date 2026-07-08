import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logging";
import { getJob, runJobNow } from "@/lib/scheduler/engine";
import { installBuiltInHandlers } from "@/lib/scheduler/executor";
import { canPerformAction } from "@/lib/scheduler/acl";

export const dynamic = "force-dynamic";
// A job's sub-agent run can take a while; keep the connection alive.
export const maxDuration = 600;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  installBuiltInHandlers();
  const { id } = await params;
  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (!canPerformAction(job, "run-now")) {
    return NextResponse.json(
      { error: `run-now is not permitted for ${job.category} job "${job.name}"` },
      { status: 403 },
    );
  }
  logger().info("scheduler.api", "run now", {
    id,
    name: job.name,
    category: job.category,
    kind: job.handler.kind,
  });
  await runJobNow(job);
  return NextResponse.json({ ok: true });
}
