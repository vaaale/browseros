import { NextRequest, NextResponse } from "next/server";
import { readApp, readDeclaredCapabilities, setAppCapabilities } from "@/lib/apps/store";
import type { AppCapability } from "@/os/types";

export const dynamic = "force-dynamic";

const VALID_CAPS = new Set<AppCapability>([
  "fs:read",
  "fs:write",
  "settings:read",
  "notify",
  "window:title",
  "services:read",
  // 040-assistant-broker-capability: without this entry the Settings toggle is a
  // silent no-op (PUT drops any capability not listed here).
  "assistant",
]);

/**
 * DECLARATION-GATED capabilities (040-assistant-broker-capability, ADR-6):
 * grantable only to an app whose own `app.json` asks for them. The sibling caps
 * are deliberately flat (any app can be given any of them); driving the
 * assistant is a stronger trust jump, so the app has to opt in first. Enforced
 * here — not only in the Settings UI — so a direct API call can't bypass it.
 */
const DECLARATION_GATED = new Set<AppCapability>(["assistant"]);

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const app = await readApp(id);
  if (!app) return NextResponse.json({ error: "App not found" }, { status: 404 });
  // `declared` is what the app's manifest ASKS for; `capabilities` is what BOS
  // has GRANTED. Settings needs both to render a declaration-gated row only
  // where it's relevant (ADR-6).
  return NextResponse.json({
    id,
    capabilities: app.capabilities ?? [],
    declared: await readDeclaredCapabilities(id),
  });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  if (!Array.isArray(body?.capabilities)) {
    return NextResponse.json({ error: "capabilities must be an array" }, { status: 400 });
  }
  const requested = (body.capabilities as string[]).filter((c): c is AppCapability =>
    VALID_CAPS.has(c as AppCapability),
  );

  const declared = new Set(await readDeclaredCapabilities(id));
  const rejected = requested.filter((c) => DECLARATION_GATED.has(c) && !declared.has(c));
  const caps = requested.filter((c) => !rejected.includes(c));

  const manifest = await setAppCapabilities(id, caps);
  if (!manifest) return NextResponse.json({ error: "App not found" }, { status: 404 });
  if (rejected.length > 0) {
    return NextResponse.json({
      app: manifest,
      rejected,
      warning:
        `Not granted: ${rejected.join(", ")} — this app's app.json does not declare ` +
        `${rejected.length > 1 ? "these capabilities" : "this capability"}.`,
    });
  }
  return NextResponse.json({ app: manifest });
}
