import { NextResponse } from "next/server";
import { listMethods } from "@/lib/specs/method/registry";
import { ensureBuiltinMethod } from "@/lib/specs/method/resolve";
import { ensureInstalledMethodPacks } from "@/lib/specs/method/install";
import { toMethodSummary } from "@/lib/specs/method/types";

export const dynamic = "force-dynamic";

// GET /api/methods -> { methods }  — installed spec methods, as client-safe
// summaries (045 FR-009/FR-014). The full descriptor, rule DSL included, stays
// server-side: shipping it to the browser would invite evaluating it there.
export async function GET() {
  ensureBuiltinMethod();
  // Installed packs, in THIS module instance — see ensureInstalledMethodPacks.
  await ensureInstalledMethodPacks().catch(() => {});
  return NextResponse.json({ methods: listMethods().map(toMethodSummary) });
}
