import { NextResponse } from "next/server";
import { getAvailableGitFsInstances } from "@/lib/gitops/filesystems";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Lists the GitFS instances configured in BOS (spec stores, installed apps,
// BrowserOS source). The Settings → Versions UI renders one card per instance.
// Discovery is dynamic (see filesystems.ts) so a GitFS added by another app
// appears here automatically.
export async function GET() {
  try {
    const filesystems = await getAvailableGitFsInstances();
    return NextResponse.json({ filesystems });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
