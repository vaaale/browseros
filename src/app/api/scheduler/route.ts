import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logging";
import { createJob, listJobs, getDaemonStatus } from "@/lib/scheduler/engine";
import { installBuiltInHandlers } from "@/lib/scheduler/executor";
import { runMigrationIfNeeded } from "@/lib/scheduler/migrate";
import type {
  CreateJobInput,
  JobHandler,
  ScheduleConfig,
} from "@/lib/scheduler/types";

export const dynamic = "force-dynamic";

// GET /api/scheduler
//   List every JobDefinition (system + user + integration) plus daemon status.
//   Runs the one-shot legacy migration lazily on first hit.
//
// POST /api/scheduler
//   Create a user-category job. Accepts EITHER the new shape
//   `{ name, handler: { kind, ... }, scheduleConfig }` OR the legacy flat
//   `{ name, prompt, agentId, scheduleConfig }` — the latter is lifted into a
//   PromptHandler on the way in so the existing UI keeps working without a
//   client-side change on the same commit.

export async function GET() {
  installBuiltInHandlers();
  await runMigrationIfNeeded();
  const [jobs, daemon] = await Promise.all([listJobs(), Promise.resolve(getDaemonStatus())]);
  // The wire field stays `tasks` for one release so no client blows up mid-deploy.
  return NextResponse.json({ tasks: jobs, jobs, daemon });
}

export async function POST(req: NextRequest) {
  installBuiltInHandlers();
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const input = normalizeCreateInput(body);
  if (typeof input === "string") return NextResponse.json({ error: input }, { status: 400 });
  try {
    const job = await createJob(input);
    logger().info("scheduler.api", "job created", {
      id: job.id,
      name: job.name,
      category: job.category,
    });
    return NextResponse.json({ task: job, job });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

/**
 * Accept both shapes:
 *   new:   { name, handler: {kind, ...}, scheduleConfig, ... }
 *   legacy:{ name, prompt, agentId, scheduleConfig, deleteAfterExecution }
 * The API only ever creates user-category jobs from this route — system and
 * integration jobs are seeded by their owning subsystem, not by an HTTP client.
 */
export function normalizeCreateInput(body: Record<string, unknown>): CreateJobInput | string {
  const name = String(body.name ?? "").trim();
  if (!name) return "name is required";
  const cfg = body.scheduleConfig as ScheduleConfig | undefined;
  if (!cfg || typeof cfg !== "object") return "scheduleConfig is required";

  let handler: JobHandler;
  if (body.handler && typeof body.handler === "object") {
    handler = body.handler as JobHandler;
    if (!("kind" in handler)) return "handler.kind is required";
  } else {
    const prompt = String(body.prompt ?? "");
    const agentId = String(body.agentId ?? "").trim();
    if (!prompt) return "prompt is required";
    if (!agentId) return "agentId is required";
    handler = { kind: "prompt", prompt, agentId };
  }

  return {
    name,
    category: "user",
    handler,
    scheduleConfig: cfg,
    deleteAfterExecution: !!body.deleteAfterExecution,
  };
}
