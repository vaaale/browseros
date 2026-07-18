import { NextRequest, NextResponse } from "next/server";
import { loadVoiceConfig, saveVoiceConfig, redactVoiceConfig } from "@/lib/voice/config";
import type { VoiceConfig } from "@/lib/voice/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const cfg = await loadVoiceConfig();
  return NextResponse.json({ config: redactVoiceConfig(cfg) });
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json() as { patch?: Partial<VoiceConfig> };
    const patch = body.patch ?? (body as Partial<VoiceConfig>);
    const cfg = await saveVoiceConfig(patch);
    return NextResponse.json({ config: redactVoiceConfig(cfg) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
