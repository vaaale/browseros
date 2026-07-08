import { NextRequest, NextResponse } from "next/server";
import "@/lib/integrations"; // side-effect: register manifests
import { startUserLogin } from "@/lib/integrations/services/telegram/auth";
import {
  IntegrationAuthError,
  IntegrationConfigError,
  IntegrationError,
} from "@/lib/integrations/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Body {
  phone?: string;
}

// POST /api/integrations/telegram/user/login/start
//
// Kicks off the phone-code flow. `phone` must be in international format
// (`+14155551234`). On success returns `{ codeSentTo: "app" | "sms", phone }`
// and stores the phoneCodeHash in-process for the verify step.
export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json(
      { error: { code: "bad_request", message: "invalid JSON body" } },
      { status: 400 },
    );
  }
  const phone = String(body.phone ?? "").trim();
  if (!phone) {
    return NextResponse.json(
      { error: { code: "bad_request", message: "phone is required" } },
      { status: 400 },
    );
  }
  try {
    const result = await startUserLogin(phone);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof IntegrationConfigError) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message } },
        { status: 400 },
      );
    }
    if (err instanceof IntegrationAuthError) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message } },
        { status: 401 },
      );
    }
    if (err instanceof IntegrationError) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message } },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: { code: "internal", message: (err as Error).message ?? "internal error" } },
      { status: 500 },
    );
  }
}
