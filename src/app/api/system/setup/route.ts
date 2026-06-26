import { NextResponse } from "next/server";
import { readNamespace, patchNamespace } from "@/lib/config/store";
import { hasCredentials } from "@/lib/agent/provider";

export const dynamic = "force-dynamic";

// First run = setup not completed AND no usable AI credentials configured yet.
export async function GET() {
  const sys = await readNamespace("system");
  const configured = await hasCredentials();
  return NextResponse.json({ firstRun: !sys.setupComplete && !configured });
}

export async function POST() {
  await patchNamespace("system", { setupComplete: true });
  return NextResponse.json({ ok: true });
}
