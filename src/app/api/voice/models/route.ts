import { NextRequest, NextResponse } from "next/server";
import { loadVoiceConfig } from "@/lib/voice/config";

export const dynamic = "force-dynamic";

interface OpenAIModel {
  id: string;
  object: string;
}

export async function GET(req: NextRequest) {
  const service = new URL(req.url).searchParams.get("service") ?? "stt";

  if (service === "stt") {
    const cfg = await loadVoiceConfig();
    try {
      const res = await fetch(`${cfg.sttUrl}/v1/models`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return NextResponse.json({ models: [], error: `HTTP ${res.status}` });
      }
      const data = await res.json() as { data?: OpenAIModel[] };
      const models = (data.data ?? [])
        .filter((m) => m.id)
        .map((m) => m.id)
        .sort();
      return NextResponse.json({ models });
    } catch (e) {
      return NextResponse.json({ models: [], error: (e as Error).message });
    }
  }

  return NextResponse.json({ models: [], error: `Unknown service: ${service}` }, { status: 400 });
}
