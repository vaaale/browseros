import { NextRequest, NextResponse } from "next/server";
import { loadVoiceConfig } from "@/lib/voice/config";
import { streamSpeech } from "@/lib/voice/tts";
import { listVoiceEngines, findActiveAudioSink } from "@/lib/voice/engine-registry";
import { currentPresenceSession } from "@/lib/voice/presence";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      text?: string; voice?: string; language?: string; sessionId?: string;
      /**
       * When true: pick the first registered engine that is NOT the currently
       * configured one (prevents infinite recursion when a plugin engine needs
       * to generate audio internally). When a string: use that specific engine id.
       */
      _bypassEngine?: boolean | string;
    };
    if (!body.text || typeof body.text !== "string" || !body.text.trim()) {
      return NextResponse.json({ error: "text is required" }, { status: 400 });
    }

    const cfg = await loadVoiceConfig();
    // _bypassEngine: lets plugin engines call TTS without infinite recursion.
    let effectiveCfg = cfg;
    if (body._bypassEngine) {
      const engineId =
        typeof body._bypassEngine === "string"
          ? body._bypassEngine
          : listVoiceEngines().find((e) => e.id !== cfg.ttsProvider)?.id ?? "openai-compatible";
      effectiveCfg = { ...cfg, ttsProvider: engineId };
    }
    const result = await streamSpeech(body.text, effectiveCfg, {
      voice: body.voice,
      language: body.language,
    });

    // An active audio sink (e.g. a connected Live Avatar) takes over playback:
    // hand it the generated audio and withhold the data URL so the browser
    // doesn't speak the same utterance a second time. Bypass calls are raw
    // audio requests made by a sink itself, so they're never re-routed.
    if (!body._bypassEngine && result.audioUrl) {
      const sink = await findActiveAudioSink(effectiveCfg.ttsProvider);
      if (sink) {
        const sessionId = body.sessionId ?? currentPresenceSession()?.sessionId ?? "";
        await sink.playAudio!({ dataUrl: result.audioUrl, durationMs: result.durationMs }, sessionId);
        return NextResponse.json({ ok: true, durationMs: result.durationMs, audioUrl: null, routedTo: sink.id });
      }
    }

    return NextResponse.json({ ok: true, durationMs: result.durationMs, audioUrl: result.audioUrl ?? null });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
