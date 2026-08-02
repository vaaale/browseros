import "server-only";
import "./openai";    // side-effect: registers "openai-compatible" engine
import "./omnivoice"; // side-effect: registers "omnivoice" engine
import { getVoiceEngine } from "@/lib/voice/engine-registry";
import type { VoiceConfig } from "../types";

export async function streamSpeech(
  text: string,
  cfg: VoiceConfig,
  _overrides: { voice?: string; language?: string } = {},
): Promise<{ durationMs: number; audioUrl?: string }> {
  const engine = getVoiceEngine(cfg.ttsProvider);
  if (!engine) throw new Error(`Unknown TTS engine: ${cfg.ttsProvider}`);
  return engine.speak(text, cfg as unknown as Record<string, unknown>, "");
}
