import { NextRequest, NextResponse } from "next/server";
import "@/lib/integrations"; // side-effect: register manifests
import { connectBot } from "@/lib/integrations/services/telegram/auth";
import {
  IntegrationAuthError,
  IntegrationConfigError,
  IntegrationError,
} from "@/lib/integrations/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Body {
  token?: string;
}

// POST /api/integrations/telegram/bot/connect
//
// Body: `{ "token": "<@BotFather bot token>" }`
//
// Validates the token via `getMe`, encrypts + persists it in the SecretsStore,
// and flips `state.connected = true` with the full BOT scope set granted. The
// UI's TelegramDetailView calls this from the "Connect" button.
export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: { code: "bad_request", message: "invalid JSON body" } }, { status: 400 });
  }
  const token = body.token?.toString() ?? "";
  if (!token.trim()) {
    return NextResponse.json(
      { error: { code: "bad_request", message: "missing `token` in body" } },
      { status: 400 },
    );
  }
  try {
    const info = await connectBot(token);
    return NextResponse.json({ ok: true, botInfo: info });
  } catch (err) {
    if (err instanceof IntegrationAuthError) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message } },
        { status: 401 },
      );
    }
    if (err instanceof IntegrationConfigError) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message } },
        { status: 400 },
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
