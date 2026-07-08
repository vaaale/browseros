import { NextRequest, NextResponse } from "next/server";
import "@/lib/integrations"; // side-effect: register manifests
import { verifyUserCode } from "@/lib/integrations/services/telegram/auth";
import {
  IntegrationAuthError,
  IntegrationConfigError,
  IntegrationError,
} from "@/lib/integrations/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Body {
  phone?: string;
  code?: string;
  password?: string;
}

// POST /api/integrations/telegram/user/login/verify
//
// Completes phone-code login. Body: `{ phone, code, password? }` — `password`
// is only required for accounts with a cloud password (2FA). On success the
// session is persisted and the user service is marked connected. If the
// account requires 2FA and no password was supplied, we return HTTP 401 with
// `code: "two_factor_required"` so the UI can prompt for it.
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
  const code = String(body.code ?? "").trim();
  const password = body.password ? String(body.password) : undefined;
  if (!phone || !code) {
    return NextResponse.json(
      { error: { code: "bad_request", message: "phone and code are required" } },
      { status: 400 },
    );
  }
  try {
    const res = await verifyUserCode({ phone, code, password });
    return NextResponse.json({ ok: true, userId: res.userId, username: res.username });
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
      // two_factor_required is a distinguishable IntegrationError — surface
      // as 401 so the UI can react (unlike generic 500s).
      const status = err.code === "two_factor_required" ? 401 : 500;
      return NextResponse.json(
        { error: { code: err.code, message: err.message } },
        { status },
      );
    }
    return NextResponse.json(
      { error: { code: "internal", message: (err as Error).message ?? "internal error" } },
      { status: 500 },
    );
  }
}
