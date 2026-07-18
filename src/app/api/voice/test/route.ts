import { NextRequest, NextResponse } from "next/server";
import { loadVoiceConfig } from "@/lib/voice/config";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const service = new URL(req.url).searchParams.get("service") ?? "stt";
  const cfg = await loadVoiceConfig();

  if (service === "stt") {
    try {
      const res = await fetch(`${cfg.sttUrl}/v1/models`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => res.statusText);
        return NextResponse.json({ ok: false, error: `HTTP ${res.status}: ${body}` });
      }
      const data = await res.json().catch(() => null);
      const models = Array.isArray(data?.data) ? data.data.length : "?";
      return NextResponse.json({ ok: true, detail: `Reachable — ${models} model(s) available` });
    } catch (e) {
      return NextResponse.json({ ok: false, error: (e as Error).message });
    }
  }

  if (service === "tts") {
    const url = cfg.ttsProvider === "omnivoice" ? cfg.omnivoice.url : cfg.openai.url;
    const pingPath = cfg.ttsProvider === "omnivoice" ? "/tts/ping" : "/v1/models";
    try {
      const res = await fetch(`${url}${pingPath}`, {
        signal: AbortSignal.timeout(5000),
        ...(cfg.ttsProvider === "openai-compatible" && cfg.openai.apiKey
          ? { headers: { Authorization: `Bearer ${cfg.openai.apiKey}` } }
          : {}),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => res.statusText);
        return NextResponse.json({ ok: false, error: `HTTP ${res.status}: ${body}` });
      }
      return NextResponse.json({ ok: true, detail: "Reachable" });
    } catch (e) {
      return NextResponse.json({ ok: false, error: (e as Error).message });
    }
  }

  return NextResponse.json({ ok: false, error: `Unknown service: ${service}` }, { status: 400 });
}
