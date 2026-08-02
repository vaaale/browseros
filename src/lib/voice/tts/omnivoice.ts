import "server-only";
import { registerVoiceEngine } from "@/lib/voice/engine-registry";
import type { VoiceConfig } from "../types";

function composeInstruct(ov: VoiceConfig["omnivoice"]): string | undefined {
  const parts = [
    ov.designGender,
    ov.designAge,
    ov.designPitch,
    ov.designStyle,
    ov.designEnglishAccent,
    ov.designChineseDialect,
  ]
    .map((s) => s.trim())
    .filter((s) => s && s.toLowerCase() !== "no preference" && s.toLowerCase() !== "auto");
  return parts.length ? parts.join(", ") : undefined;
}

/** Omnivoice rejects expressive bracket tags ("[laughter]", "[sigh]") in every
 *  mode except Voice Clone, so they must be removed rather than passed through
 *  — an LLM reply containing one would otherwise fail the whole utterance. */
function stripBracketTags(text: string): string {
  return text.replace(/\[[^\]\n]*\]/g, " ").replace(/\s{2,}/g, " ").trim();
}

async function streamOmnivoice(text: string, cfg: VoiceConfig, voice?: string, language?: string): Promise<Response> {
  const ov = cfg.omnivoice;
  const body: Record<string, unknown> = {
    text,
    format: ov.format,
    speed: ov.speed,
    num_step: ov.numStep,
    guidance_scale: ov.guidanceScale,
    denoise: ov.denoise,
    preprocess_prompt: ov.preprocessPrompt,
    postprocess_output: ov.postprocessOutput,
    pad_duration: ov.padDuration,
    fade_duration: ov.fadeDuration,
    t_shift: ov.tShift,
    layer_penalty_factor: ov.layerPenaltyFactor,
    position_temperature: ov.positionTemperature,
    class_temperature: ov.classTemperature,
    pitch_semitones: ov.pitchSemitones,
    tempo: ov.tempo,
    volume: ov.volume,
    normalize: ov.normalize,
    randomize_seed: ov.randomizeSeed,
  };

  const lang = language ?? ov.language;
  if (lang) body.language = lang;

  if (voice) {
    body.voice = voice;
  } else if (ov.voiceSource === "design") {
    const instruct = composeInstruct(ov);
    if (instruct) body.instruct = instruct;
  } else if (ov.voiceSource === "clone" && ov.refAudioPath) {
    body.ref_audio = ov.refAudioPath;
    if (ov.refText) body.ref_text = ov.refText;
  } else if (ov.voice) {
    body.voice = ov.voice;
  }
  if (!ov.randomizeSeed && ov.seed !== null) body.seed = ov.seed;

  const res = await fetch(`${ov.url}/tts/stream-chunks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Omnivoice TTS error ${res.status}: ${errText}`);
  }
  return res;
}

registerVoiceEngine({
  id: "omnivoice",
  displayName: "OmniVoice TTS",
  async speak(text, config, _sessionId) {
    const cfg = config as unknown as VoiceConfig;
    const spoken = cfg.omnivoice.voiceSource === "clone" ? text : stripBracketTags(text);
    if (!spoken) return { durationMs: 0 };
    const res = await streamOmnivoice(spoken, cfg);
    const buffer = await res.arrayBuffer();
    const mimeType = res.headers.get("content-type") ?? "audio/mpeg";
    const bitrate = 128000;
    const durationMs = Math.round((buffer.byteLength * 8 / bitrate) * 1000);
    const base64 = Buffer.from(buffer).toString("base64");
    return { durationMs: Math.max(durationMs, 500), audioUrl: `data:${mimeType};base64,${base64}` };
  },
  async interrupt(_sessionId) {},
});
