import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { dataDir } from "@/os/data-dir";

export const dynamic = "force-dynamic";

// Cheap readiness probe used by the self-modification Supervisor's build/health
// gate (spec/self-modification/self-modification.md §4) and for version liveness.
// 200 + { ok: true } means the process is up and can read its data root.
export async function GET() {
  let dataReadable = false;
  try {
    await fs.access(dataDir());
    dataReadable = true;
  } catch {
    dataReadable = false;
  }
  return NextResponse.json({
    ok: true,
    dataDir: dataDir(),
    dataReadable,
    // Set per version by the Supervisor (active/next/previous) when launched.
    version: process.env.BOS_VERSION_LABEL ?? null,
    uptimeSeconds: Math.round(process.uptime()),
  });
}
