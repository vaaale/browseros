import { NextRequest, NextResponse } from "next/server";
import "@/lib/integrations"; // side-effect: register manifests
import { setUserCredentials } from "@/lib/integrations/services/telegram/auth";
import {
  IntegrationAuthError,
  IntegrationConfigError,
  IntegrationError,
} from "@/lib/integrations/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Body {
  apiId?: string | number;
  apiHash?: string;
}

// POST /api/integrations/telegram/user/credentials
//
// Persists api_id + api_hash to SecretsStore and marks the user service
// "credentials set". No network call is made here — the sign-in flow starts
// separately at .../user/login/start.
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
  const apiId = String(body.apiId ?? "").trim();
  const apiHash = String(body.apiHash ?? "").trim();
  if (!apiId || !apiHash) {
    return NextResponse.json(
      { error: { code: "bad_request", message: "apiId and apiHash are required" } },
      { status: 400 },
    );
  }
  try {
    await setUserCredentials(apiId, apiHash);
    return NextResponse.json({ ok: true });
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
