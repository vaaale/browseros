import { NextResponse } from "next/server";
import { loadVoiceConfig } from "@/lib/voice/config";

export const dynamic = "force-dynamic";

// Omnivoice's supported speech languages (parallel id/name arrays). Proxied
// so the browser needn't reach the Omnivoice host directly. Best-effort:
// returns an empty list if unreachable so the UI falls back to a text input.
export async function GET() {
  const cfg = await loadVoiceConfig();
  try {
    const res = await fetch(`${cfg.omnivoice.url}/tts/languages`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return NextResponse.json({ languages: [] });
    const data = (await res.json()) as { language_ids?: string[]; language_names?: string[] };
    const ids = Array.isArray(data.language_ids) ? data.language_ids : [];
    const names = Array.isArray(data.language_names) ? data.language_names : [];
    const languages = ids.map((id, i) => ({ id, name: names[i] ?? id }));
    return NextResponse.json({ languages });
  } catch {
    return NextResponse.json({ languages: [] });
  }
}
