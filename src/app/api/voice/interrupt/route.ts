import { NextRequest, NextResponse } from "next/server";
import { loadVoiceConfig } from "@/lib/voice/config";
import { getVoiceEngine, findActiveAudioSink } from "@/lib/voice/engine-registry";
import { currentPresenceSession } from "@/lib/voice/presence";
import "@/lib/voice/tts"; // side-effect: ensures built-in engines are registered

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json() as { sessionId?: string };
  // The engine session belongs to the presence window now, so the browser no
  // longer tracks an id — the server knows which session is live.
  const sessionId = body.sessionId ?? currentPresenceSession()?.sessionId ?? "";
  const cfg = await loadVoiceConfig();
  const engine = getVoiceEngine(cfg.ttsProvider);
  await engine?.interrupt(sessionId);
  // A sink that took over playback buffers its own audio, so it must stop too.
  const sink = await findActiveAudioSink(cfg.ttsProvider);
  await sink?.interrupt(sessionId);
  return NextResponse.json({ ok: true });
}
