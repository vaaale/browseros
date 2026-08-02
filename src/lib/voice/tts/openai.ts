import "server-only";
import { registerVoiceEngine } from "@/lib/voice/engine-registry";
import type { VoiceConfig } from "../types";

async function streamOpenAI(text: string, cfg: VoiceConfig): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.openai.apiKey) headers["Authorization"] = `Bearer ${cfg.openai.apiKey}`;

  const body: Record<string, unknown> = {
    model: cfg.openai.model,
    voice: cfg.openai.voice,
    input: text,
    response_format: cfg.openai.responseFormat,
    speed: cfg.openai.speed,
  };

  const res = await fetch(`${cfg.openai.url}/v1/audio/speech`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`OpenAI TTS error ${res.status}: ${errText}`);
  }
  return res;
}

registerVoiceEngine({
  id: "openai-compatible",
  displayName: "OpenAI-compatible TTS",
  async speak(text, config, _sessionId) {
    const cfg = config as unknown as VoiceConfig;
    const res = await streamOpenAI(text, cfg);
    const buffer = await res.arrayBuffer();
    const mimeType = res.headers.get("content-type") ?? "audio/mpeg";
    // Estimate duration from byte length and bitrate (128kbps mp3 default)
    const bitrate = 128000;
    const durationMs = Math.round((buffer.byteLength * 8 / bitrate) * 1000);
    const base64 = Buffer.from(buffer).toString("base64");
    return { durationMs: Math.max(durationMs, 500), audioUrl: `data:${mimeType};base64,${base64}` };
  },
  async interrupt(_sessionId) {
    // HTTP TTS — nothing to cancel server-side
  },
});
