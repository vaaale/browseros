import { NextResponse } from "next/server";
import "@/lib/integrations"; // side-effect: register manifests
import {
  ensureSchedulerStarted,
  getSchedulerStatus,
  tick,
} from "@/lib/integrations/scheduler/daemon";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/integrations/scheduler
//   Snapshot of the polling daemon: running flag, tick counter, per-job runtime
//   status (last attempt / success, current backoff, last error). Called by the
//   Settings UI's Polling section for the live "next poll in N s" hint.
//
// POST /api/integrations/scheduler
//   Force a single tick immediately (development / debugging helper). No body.
//   Returns the updated status.

export async function GET() {
  ensureSchedulerStarted();
  return NextResponse.json({ status: getSchedulerStatus() });
}

export async function POST() {
  ensureSchedulerStarted();
  await tick();
  return NextResponse.json({ status: getSchedulerStatus() });
}
