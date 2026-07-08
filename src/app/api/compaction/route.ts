import { NextResponse, type NextRequest } from "next/server";
import { readSidecar } from "@/lib/agent/compaction/sidecar";
import { summarizeConversation } from "@/lib/agent/compaction/summarize";
import { logger } from "@/lib/logging";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const COMPONENT = "compaction";

function logEvent(level: "info" | "warn" | "error", conv: string, msg: string, data?: Record<string, unknown>): void {
  logger().log({ level, component: COMPONENT, conversation: conv, msg, ...(data ? { data } : {}) });
}

function requireSameOrigin(req: NextRequest): boolean {
  // Same-origin guard: the fetch API always sends `Sec-Fetch-Site` for
  // cross-origin requests. Absence or `same-origin` is allowed; anything else
  // is rejected. Server-side callers (e.g. curl without the header) still pass.
  const site = req.headers.get("sec-fetch-site");
  if (!site) return true;
  return site === "same-origin" || site === "none";
}

/** GET /api/compaction?conv=<id> — returns the sidecar view (or 404). */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const conv = (url.searchParams.get("conv") || "").trim();
  if (!conv) return NextResponse.json({ error: "missing ?conv=<id>" }, { status: 400 });
  try {
    const sidecar = await readSidecar(conv);
    if (!sidecar) {
      logEvent("info", conv, "api.get-miss");
      return NextResponse.json({ error: "no sidecar" }, { status: 404 });
    }
    logEvent("info", conv, "api.get", { hasSummary: !!sidecar.summary, boundaryCount: sidecar.boundary?.count ?? null });
    return NextResponse.json({
      conv,
      boundary: sidecar.boundary,
      summary: sidecar.summary,
      clearWatermark: sidecar.clearWatermark,
      lock: sidecar.lock,
      updatedAt: sidecar.updatedAt,
      stats: sidecar.stats,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/** POST /api/compaction?conv=<id> — force a summarization now. */
export async function POST(req: NextRequest) {
  if (!requireSameOrigin(req)) {
    return NextResponse.json({ error: "cross-origin not allowed" }, { status: 403 });
  }
  const url = new URL(req.url);
  const conv = (url.searchParams.get("conv") || "").trim();
  if (!conv) return NextResponse.json({ error: "missing ?conv=<id>" }, { status: 400 });
  try {
    const result = await summarizeConversation(conv, { manual: true });
    logEvent("info", conv, "api.post", { outcome: "skipped" in result ? result.reason : "applied" });
    return NextResponse.json(result);
  } catch (err) {
    logEvent("error", conv, "api.post failed", { error: (err as Error).message });
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
