export type TTSProviderType = "openai-compatible" | "omnivoice";
/** How the agent's replies reach the user (036). One setting, so "a face on
 *  screen with the sound off" is not a representable state:
 *  - "off"    — replies are text only; nothing is synthesized.
 *  - "audio"  — replies are spoken.
 *  - "avatar" — replies are spoken by an embodied engine in the presence window. */
export type VoiceOutputMode = "off" | "audio" | "avatar";
export type VoiceActivationMode = "button" | "wake-word" | "key";
export type WakeWordEngine = "speaches" | "onnx";
export type VoiceStatus =
  | "idle"
  | "dormant"       // always-on: waiting for wake word
  | "awake"         // wake word detected — ready to receive utterance (green mic)
  | "listening"     // recording speech
  | "transcribing"
  | "thinking"
  | "speaking"
  | "interrupting";

export interface OpenAITTSConfig {
  url: string;
  apiKey: string;
  model: string;
  voice: string;
  speed: number;
  responseFormat: "mp3" | "wav" | "opus" | "aac" | "flac";
}

export type OmnivoiceVoiceSource = "alias" | "design" | "clone";
export type OmnivoiceFormat = "mp3" | "wav" | "flac" | "ogg";

export interface OmnivoiceTTSConfig {
  url: string;
  /** Which voice input is active — the provider sends ONLY the matching field
   *  (alias→voice, design→instruct, clone→ref_audio) so a leftover value in
   *  another field can't override the selection. */
  voiceSource: OmnivoiceVoiceSource;
  voice: string;

  // Voice design — structured attributes composed into the `instruct` string
  // (empty string = "no preference", dropped from the composition). Order:
  // gender, age, pitch, style, english accent, chinese dialect, then manual.
  designGender: string;
  designAge: string;
  designPitch: string;
  designStyle: string;
  designEnglishAccent: string;
  designChineseDialect: string;

  // Voice clone
  refAudioPath: string;
  refText: string;

  // Speech
  language: string; // "" = Auto
  format: OmnivoiceFormat;

  // Generation Settings
  speed: number;              // 0.5–1.5
  numStep: number;            // 4–64
  guidanceScale: number;      // 0–4
  denoise: boolean;
  preprocessPrompt: boolean;
  postprocessOutput: boolean;
  padDuration: number;
  fadeDuration: number;

  // Advanced Controls (nested under Generation Settings in Omnivoice's UI)
  tShift: number;             // 0.01–1
  layerPenaltyFactor: number; // 0–10
  positionTemperature: number;// 0–10
  classTemperature: number;   // 0–2
  seed: number | null;
  randomizeSeed: boolean;

  // Audio Controls
  pitchSemitones: number;     // -12–12
  tempo: number;              // 0.5–2
  volume: number;             // 0–2
  normalize: boolean;
}

export interface VoiceConfig {
  // STT
  sttUrl: string;
  sttModel: string;
  language: string;

  // Activation
  activationMode: VoiceActivationMode;
  wakeWord: string;
  wakeWordEngine: WakeWordEngine;
  /** KeyboardEvent.code used for key-to-talk (e.g. "ControlLeft"). Held-down =
   *  recording; release = submit. Ignored in other activation modes. */
  activationKey: string;

  // VAD
  vadThreshold: number;
  minSilenceMs: number;

  // TTS
  ttsProvider: string; // "openai-compatible" | "omnivoice" | plugin-registered id
  openai: OpenAITTSConfig;
  omnivoice: OmnivoiceTTSConfig;

  // Real-time conversation
  /** Interruptions within this window (ms) after the agent starts speaking
   *  amend + resubmit the previous message; later interruptions start a new turn. */
  interruptGraceMs: number;
  /** How long (ms) the agent stays awake (no wake word needed) after a turn. */
  awakeTimeoutMs: number;
  /** THE output switch, driven by the speaker and video buttons in the Assistant
   *  input row. Nothing else gates speech: if this isn't "off", replies are
   *  spoken — whether the message was typed or dictated. */
  voiceOutput: VoiceOutputMode;
}
