import type { VoiceEnginePlugin } from "@/lib/bos-plugins/types";
import { isPresenceLive } from "./presence";

const KEY = "__bos_voice_engines__" as const;

function getRegistry(): Map<string, VoiceEnginePlugin> {
  const g = globalThis as Record<string, unknown>;
  if (!g[KEY]) g[KEY] = new Map<string, VoiceEnginePlugin>();
  return g[KEY] as Map<string, VoiceEnginePlugin>;
}

export function registerVoiceEngine(engine: VoiceEnginePlugin): void {
  getRegistry().set(engine.id, engine);
}

export function unregisterVoiceEngine(id: string): void {
  getRegistry().delete(id);
}

export function getVoiceEngine(id: string): VoiceEnginePlugin | undefined {
  return getRegistry().get(id);
}

export function listVoiceEngines(): VoiceEnginePlugin[] {
  return [...getRegistry().values()];
}

/** The engine currently able to render audio generated elsewhere (see
 *  VoiceEnginePlugin.isSinkActive), excluding `excludeId` — the configured
 *  engine already delivers its own audio.
 *
 *  An engine with a surface must ALSO hold a live presence lease: "the plugin
 *  says its socket is up" is not evidence that anything is on screen, and
 *  routing audio to a surface that isn't rendering loses the reply entirely
 *  (036 FR-013). Engines with no surface — a speaker, a phone bridge — have
 *  nothing to render and are trusted on isSinkActive() alone. */
export async function findActiveAudioSink(excludeId: string): Promise<VoiceEnginePlugin | undefined> {
  for (const engine of listVoiceEngines()) {
    if (engine.id === excludeId || !engine.isSinkActive || !engine.playAudio) continue;
    if (engine.surface && !isPresenceLive(engine.id)) continue;
    if (await engine.isSinkActive()) return engine;
  }
  return undefined;
}
