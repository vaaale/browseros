import "server-only";
import type { VoiceConfig } from "../types";

interface SpeechOverrides {
  voice?: string;
  language?: string;
}

async function streamOpenAI(text: string, cfg: VoiceConfig, overrides: SpeechOverrides): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.openai.apiKey) headers["Authorization"] = `Bearer ${cfg.openai.apiKey}`;

  const body: Record<string, unknown> = {
    model: cfg.openai.model,
    voice: overrides.voice ?? cfg.openai.voice,
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

// Compose the Omnivoice voice-design instruct from the structured attributes,
// mirroring the server's build_voice_design_instruct(): join non-empty values
// (dropping "no preference"/"auto") with ", " in category order. Only the
// predefined vocabulary is used — this model build produces empty audio when
// the instruct contains free-form descriptors, so there is no free-text field.
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

async function streamOmnivoice(text: string, cfg: VoiceConfig, overrides: SpeechOverrides): Promise<Response> {
  const ov = cfg.omnivoice;
  // Field names match Omnivoice's TTSRequest schema exactly.
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

  const language = overrides.language ?? ov.language;
  if (language) body.language = language; // omit → Auto

  // Send ONLY the field for the active voice source so a leftover value in
  // another field can't override the selection. An explicit `overrides.voice`
  // (e.g. an alias preview) always wins.
  if (overrides.voice) {
    body.voice = overrides.voice;
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

export async function streamSpeech(
  text: string,
  cfg: VoiceConfig,
  overrides: SpeechOverrides = {},
): Promise<Response> {
  if (cfg.ttsProvider === "openai-compatible") {
    return streamOpenAI(text, cfg, overrides);
  }
  return streamOmnivoice(text, cfg, overrides);
}
