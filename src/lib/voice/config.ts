import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { dataDir } from "@/os/data-dir";
import { writeFileAtomic } from "@/os/atomic-write";
import type { VoiceConfig } from "./types";

const CONFIG_PATH = path.join(dataDir(), "voice-config.json");

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  sttUrl: "http://wizzo.akhbar.lan:8082",
  sttModel: "Systran/faster-distil-whisper-small.en",
  language: "en",
  activationMode: "button",
  wakeWord: "hey bos",
  wakeWordEngine: "speaches",
  vadThreshold: 0.75,
  minSilenceMs: 700,
  ttsProvider: "omnivoice",
  openai: {
    url: "https://api.openai.com",
    apiKey: "",
    model: "tts-1",
    voice: "nova",
    speed: 1.0,
    responseFormat: "mp3",
  },
  omnivoice: {
    url: "http://wizzo.akhbar.lan:7861",
    voiceSource: "design",
    voice: "nova",
    designGender: "female",
    designAge: "",
    designPitch: "",
    designStyle: "",
    designEnglishAccent: "",
    designChineseDialect: "",
    refAudioPath: "",
    refText: "",
    language: "", // Auto
    format: "mp3",
    // Generation Settings (Omnivoice defaults)
    speed: 1.0,
    numStep: 32,
    guidanceScale: 2.0,
    denoise: true,
    preprocessPrompt: true,
    postprocessOutput: true,
    padDuration: 0.1,
    fadeDuration: 0.1,
    // Advanced Controls
    tShift: 0.1,
    layerPenaltyFactor: 5.0,
    positionTemperature: 5.0,
    classTemperature: 0.0,
    // Stable voice by default: a fixed seed (not randomized) keeps the same
    // voice across every utterance in a conversation. Since this Omnivoice
    // build ignores the OpenAI voice aliases, the seed IS the voice identity
    // in "auto"/alias mode.
    seed: 42,
    randomizeSeed: false,
    // Audio Controls
    pitchSemitones: 0.0,
    tempo: 1.0,
    volume: 1.0,
    normalize: false,
  },
  enabled: false,
  interruptGraceMs: 2000,
  awakeTimeoutMs: 5000,
  speakReplies: true,
};

export async function loadVoiceConfig(): Promise<VoiceConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const stored = JSON.parse(raw) as Partial<VoiceConfig>;
    const omnivoice = { ...DEFAULT_VOICE_CONFIG.omnivoice, ...(stored.omnivoice ?? {}) };
    // Migrate configs saved before voiceSource existed: infer the active source
    // from whichever field was populated so an existing clone setup isn't
    // silently downgraded.
    if (stored.omnivoice && !stored.omnivoice.voiceSource) {
      omnivoice.voiceSource = stored.omnivoice.refAudioPath ? "clone" : "alias";
    }
    return {
      ...DEFAULT_VOICE_CONFIG,
      ...stored,
      openai: { ...DEFAULT_VOICE_CONFIG.openai, ...(stored.openai ?? {}) },
      omnivoice,
    };
  } catch {
    return { ...DEFAULT_VOICE_CONFIG };
  }
}

export async function saveVoiceConfig(patch: Partial<VoiceConfig>): Promise<VoiceConfig> {
  const current = await loadVoiceConfig();
  const next: VoiceConfig = {
    ...current,
    ...patch,
    openai: { ...current.openai, ...(patch.openai ?? {}) },
    omnivoice: { ...current.omnivoice, ...(patch.omnivoice ?? {}) },
  };
  await writeFileAtomic(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

export function redactVoiceConfig(cfg: VoiceConfig): VoiceConfig {
  return {
    ...cfg,
    openai: {
      ...cfg.openai,
      apiKey: cfg.openai.apiKey ? "***" : "",
    },
  };
}
