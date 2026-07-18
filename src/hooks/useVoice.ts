"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useChatState } from "@/lib/assistant/client/chat-store";
import { sendMessage, stopRun } from "@/lib/assistant/client/run-client";
import type { VoiceConfig, VoiceStatus, VoiceActivationMode } from "@/lib/voice/types";
import type { MicVAD } from "@ricky0123/vad-web";

export interface UseVoiceOptions {
  conversationId: string;
  agentId: string;
  /** PTT dictation callback — receives the transcript instead of auto-submitting.
   *  Ignored by the always-on session loop, which always submits to the agent. */
  onTranscript?: (transcript: string) => void;
  onError?: (error: string) => void;
  ensureConversation?: () => Promise<string>;
}

export interface UseVoiceReturn {
  status: VoiceStatus;
  transcript: string;
  error: string | null;
  stream: MediaStream | null;
  config: VoiceConfig | null;
  activationMode: VoiceActivationMode;
  isEnabled: boolean;
  isActive: boolean;
  startListening: () => Promise<void>;
  stopListening: () => void;
  speak: (text: string) => void;
  stopSpeaking: () => void;
  activate: () => void;
  deactivate: () => void;
  reloadConfig: () => Promise<void>;
}

// Energy-based VAD. vadThreshold (0.1–1.0 sensitivity): higher → lower energy
// ceiling → triggers on quieter sounds.
const VAD_MAX_ENERGY = 0.04;
const VAD_POLL_INTERVAL_MS = 100;
// PTT only: suppress the silence detector briefly so the user has time to
// start speaking after clicking the mic.
const PTT_MIN_RECORDING_MS = 1500;
// Pre-roll: audio kept from BEFORE speech detection. The VAD needs a few
// hundred ms to trigger, so without pre-roll the first word ("hey…") is
// clipped from every clip and short wake words never match.
const PRE_ROLL_MS = 600;
// Hard cap on a single utterance recording.
const MAX_UTTERANCE_MS = 60_000;
// ScriptProcessor buffer size (samples). 4096 @ 48 kHz ≈ 85 ms per callback.
const PCM_BUFFER_SIZE = 4096;

const MIC_CONSTRAINTS: MediaStreamConstraints = {
  // Echo cancellation keeps the assistant's own TTS (from speakers) from
  // triggering the VAD and self-interrupting.
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

function measureRMS(analyser: AnalyserNode): number {
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const v of data) { const n = (v - 128) / 128; sum += n * n; }
  return Math.sqrt(sum / data.length);
}

function pcmRMS(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) { const v = samples[i]!; sum += v * v; }
  return Math.sqrt(sum / samples.length);
}

/** Encode mono Float32 PCM chunks as a 16-bit WAV blob. Speaches/Whisper
 *  resample internally, so we send the AudioContext's native rate. */
function encodeWAV(chunks: Float32Array[], sampleRate: number): Blob {
  let total = 0;
  for (const c of chunks) total += c.length;
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + total * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);        // PCM
  view.setUint16(22, 1, true);        // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, total * 2, true);
  let off = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const s = Math.max(-1, Math.min(1, c[i]!));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Split off complete sentences (ending in .!?…). minLen guards against
 *  emitting stray punctuation fragments, not against short sentences. */
function splitSentences(text: string, minLen: number): { complete: string[]; remainder: string } {
  const complete: string[] = [];
  const regex = /[.!?…]+(?:\s+|$)/g;
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const end = match.index + match[0].length;
    const candidate = text.slice(lastEnd, end).trim();
    if (candidate.length >= minLen) { complete.push(candidate); lastEnd = end; }
  }
  return { complete, remainder: text.slice(lastEnd) };
}

// Whisper adds punctuation/casing freely ("Hey, Bos!"), so wake-word matching
// must compare punctuation-free, whitespace-collapsed lowercase text.
function normalizeSpeech(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

// Whisper (trained on YouTube captions) hallucinates a small predictable set
// of phrases on residual noise/near-silence — >50% of noise hallucinations are
// the top ~10 phrases (arXiv 2501.11378). A transcript that IS one of these
// (normalized, whole-message match) is discarded, never submitted.
const WHISPER_HALLUCINATIONS = new Set([
  "you",
  "bye",
  "so",
  "uh",
  "thank you",
  "thank you bye",
  "thanks for watching",
  "thank you for watching",
  "please subscribe",
  "please like and subscribe",
  "subtitles by the amara org community",
  "the end",
]);

function isHallucinatedTranscript(normalized: string): boolean {
  return WHISPER_HALLUCINATIONS.has(normalized);
}

interface ActiveRecording {
  recorder: MediaRecorder;
  chunks: Blob[];
}

export function useVoice({
  conversationId,
  agentId,
  onTranscript,
  onError,
  ensureConversation,
}: UseVoiceOptions): UseVoiceReturn {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  const [isActive, setIsActive] = useState(false);

  // Mirror status in a ref so audio callbacks read the live value.
  const statusRef = useRef<VoiceStatus>("idle");
  const setStatusBoth = useCallback((s: VoiceStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  // ALL config values as refs — audio callbacks must never capture stale closures.
  const configRef = useRef<VoiceConfig | null>(null);
  const silenceCeilingRef = useRef(0.01);
  const minSilenceMsRef = useRef(700);
  const interruptGraceMsRef = useRef(2000);
  const awakeTimeoutMsRef = useRef(5000);
  const speakRepliesRef = useRef(true);
  useEffect(() => {
    configRef.current = config;
    silenceCeilingRef.current = (1 - (config?.vadThreshold ?? 0.75)) * VAD_MAX_ENERGY;
    minSilenceMsRef.current = config?.minSilenceMs ?? 700;
    interruptGraceMsRef.current = config?.interruptGraceMs ?? 2000;
    awakeTimeoutMsRef.current = config?.awakeTimeoutMs ?? 5000;
    speakRepliesRef.current = config?.speakReplies !== false;
  }, [config]);

  // Latest-value refs for caller-supplied props. Callers often pass inline
  // arrows (new identity every parent render — ChatInputV2 re-renders on every
  // run event). If these lived in dependency arrays, every parent render would
  // recreate our callbacks and re-fire cleanup effects, tearing down a live
  // session mid-conversation. All internal callbacks read these refs instead.
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  const ensureConversationRef = useRef(ensureConversation);
  const conversationIdRef = useRef(conversationId);
  const agentIdRef = useRef(agentId);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    onErrorRef.current = onError;
    ensureConversationRef.current = ensureConversation;
    conversationIdRef.current = conversationId;
    agentIdRef.current = agentId;
  });

  // Always-on session refs. The source node is held strongly — without a
  // reference some browsers GC it, silently disconnecting the audio graph.
  const sessionStreamRef = useRef<MediaStream | null>(null);
  const sessionAudioCtxRef = useRef<AudioContext | null>(null);
  const sessionProcRef = useRef<ScriptProcessorNode | null>(null);
  const sessionSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  // Primary VAD engine: Silero neural VAD (null when the energy fallback runs).
  const sileroVADRef = useRef<MicVAD | null>(null);
  const speechActiveRef = useRef(false);
  const silenceStartRef = useRef<number | null>(null);
  const forceCommitRef = useRef(false);
  const isActiveRef = useRef(false);

  // Awake state (wake word heard; green mic; 5 s inactivity window)
  const awakeRef = useRef(false);
  const awakeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Push-to-talk refs
  const ptRecRef = useRef<ActiveRecording | null>(null);
  const ptStreamRef = useRef<MediaStream | null>(null);
  const ptVADRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ptAudioCtxRef = useRef<AudioContext | null>(null);
  const ptSilenceStartRef = useRef<number | null>(null);

  // TTS refs — generation counter cancels queued-but-not-started segments.
  const ttsAbortRef = useRef<AbortController | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsQueueRef = useRef<Promise<void>>(Promise.resolve());
  const ttsGenRef = useRef(0);
  const pendingTTSRef = useRef(0);

  // Interruption combining
  const lastSubmittedRef = useRef("");
  const isInterruptingRef = useRef(false);
  // When the FIRST TTS audio of the current turn started playing. Barge-ins
  // within interruptGraceMs of this amend + resubmit; later ones start a new turn.
  const speakingStartedAtRef = useRef<number | null>(null);

  // Run-stream watching for sentence TTS: cursor over the stream snapshot.
  const chatState = useChatState(conversationId);
  const streamSnapshotRef = useRef("");
  const spokenLenRef = useRef(0);
  const prevRunningRef = useRef(false);
  // Live mirror of chatState.running for stable callbacks (is_generating).
  const runningRef = useRef(false);

  const showError = useCallback((msg: string) => {
    console.warn("[voice]", msg);
    setError(msg);
    onErrorRef.current?.(msg);
    setTimeout(() => setError(null), 6000);
  }, []);

  // Push threshold changes into a live Silero VAD instance (callback, not
  // effect — the React Compiler forbids mutating refs it sees read in effects).
  const applyVADOptions = useCallback((cfg: VoiceConfig) => {
    sileroVADRef.current?.setOptions({
      positiveSpeechThreshold: cfg.vadThreshold,
      negativeSpeechThreshold: Math.max(0.05, cfg.vadThreshold - 0.15),
      redemptionMs: cfg.minSilenceMs,
    });
  }, []);

  const reloadConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/voice").then((r) => r.json()) as { config?: VoiceConfig };
      if (res.config) {
        setConfig(res.config);
        applyVADOptions(res.config);
      }
    } catch { /* non-fatal */ }
  }, [applyVADOptions]);

  useEffect(() => {
    const id = setTimeout(() => void reloadConfig(), 0);
    return () => clearTimeout(id);
  }, [reloadConfig]);

  // ── Awake lifecycle ─────────────────────────────────────────────────────────

  const clearAwakeTimeout = useCallback(() => {
    if (awakeTimeoutRef.current) { clearTimeout(awakeTimeoutRef.current); awakeTimeoutRef.current = null; }
  }, []);

  const armAwakeTimeout = useCallback(() => {
    clearAwakeTimeout();
    awakeTimeoutRef.current = setTimeout(() => {
      awakeTimeoutRef.current = null;
      if (!isActiveRef.current) return;
      // Only demote when idle-awake; mid-turn the ready-status restore re-arms.
      if (statusRef.current === "awake") {
        awakeRef.current = false;
        setStatusBoth("dormant");
      }
    }, awakeTimeoutMsRef.current);
  }, [clearAwakeTimeout, setStatusBoth]);

  /** Unconditional: set the session's ready state (awake with timer, or dormant). */
  const setReadyStatus = useCallback(() => {
    speakingStartedAtRef.current = null;
    if (!isActiveRef.current) { setStatusBoth("idle"); return; }
    if (awakeRef.current) { setStatusBoth("awake"); armAwakeTimeout(); }
    else setStatusBoth("dormant");
  }, [armAwakeTimeout, setStatusBoth]);

  /** Guarded: restore ready state only from turn-terminal states. Never clobbers
   *  listening/transcribing (a new turn may have started via interruption).
   *  While the run is still generating (TTS drained faster than the LLM), the
   *  correct state is "thinking", not ready — more sentences are coming. */
  const restoreReadyStatus = useCallback(() => {
    if (statusRef.current !== "thinking" && statusRef.current !== "speaking") return;
    if (runningRef.current) { setStatusBoth("thinking"); return; }
    setReadyStatus();
  }, [setReadyStatus, setStatusBoth]);

  // ── TTS ─────────────────────────────────────────────────────────────────────

  const speakSegment = useCallback(async (text: string): Promise<void> => {
    if (!text.trim()) return;
    const abort = new AbortController();
    ttsAbortRef.current = abort;
    setStatusBoth("speaking");
    try {
      const res = await fetch("/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: abort.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(body);
      }
      if (abort.signal.aborted) return;
      const blob = await res.blob();
      if (abort.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      ttsAudioRef.current = audio;
      // Stamp the moment the turn's speech becomes audible (first segment only).
      if (speakingStartedAtRef.current === null) speakingStartedAtRef.current = Date.now();
      await new Promise<void>((resolve) => {
        audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
        audio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
        abort.signal.addEventListener("abort", () => { audio.pause(); URL.revokeObjectURL(url); resolve(); });
        void audio.play().catch(resolve);
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") showError(`TTS error: ${(e as Error).message}`);
    }
  }, [setStatusBoth, showError]);

  const speak = useCallback((text: string) => {
    const gen = ttsGenRef.current;
    pendingTTSRef.current += 1;
    ttsQueueRef.current = ttsQueueRef.current.then(async () => {
      try {
        // Skip segments queued before an interruption bumped the generation.
        if (gen === ttsGenRef.current) await speakSegment(text);
      } finally {
        pendingTTSRef.current = Math.max(0, pendingTTSRef.current - 1);
        if (pendingTTSRef.current === 0) restoreReadyStatus();
      }
    });
  }, [speakSegment, restoreReadyStatus]);

  const stopSpeaking = useCallback(() => {
    ttsGenRef.current += 1; // queued-but-not-started segments will be skipped
    ttsAbortRef.current?.abort();
    if (ttsAudioRef.current) { ttsAudioRef.current.pause(); ttsAudioRef.current = null; }
  }, []);

  // ── Auto-submit (session mode) ──────────────────────────────────────────────

  const autoSubmit = useCallback(async (text: string) => {
    if (!text.trim()) { setReadyStatus(); return; }
    speakingStartedAtRef.current = null; // new turn — reset the speech clock
    setStatusBoth("thinking");
    const ensure = ensureConversationRef.current;
    const convId = conversationIdRef.current || (ensure ? await ensure() : "");
    if (!convId) {
      showError("Voice: no active conversation to submit to");
      setReadyStatus();
      return;
    }
    const res = await sendMessage(convId, agentIdRef.current, text);
    if (!res.ok) {
      showError(`Send failed: ${res.error}`);
      setReadyStatus();
    }
    // On success, status leaves "thinking" via TTS or the run-finish watcher.
  }, [showError, setReadyStatus, setStatusBoth]);

  // ── Transcription ───────────────────────────────────────────────────────────

  const transcribeBlob = useCallback(async (blob: Blob): Promise<string> => {
    const form = new FormData();
    const name = blob.type.includes("wav") ? "audio.wav" : "audio.webm";
    form.append("audio", blob, name);
    const res = await fetch("/api/voice/stt", { method: "POST", body: form });
    if (!res.ok) {
      const body = await res.text().catch(() => `HTTP ${res.status}`);
      let msg = body;
      try { msg = (JSON.parse(body) as { error?: string }).error ?? body; } catch { /* raw */ }
      throw new Error(`STT: ${msg}`);
    }
    const data = await res.json() as { transcript?: string; error?: string };
    if (data.error) throw new Error(`STT: ${data.error}`);
    return (data.transcript ?? "").trim();
  }, []);

  // ── Clip processing (shared by both VAD engines) ───────────────────────────

  const backToReady = useCallback(() => {
    if (!isActiveRef.current) return;
    if (awakeRef.current) { setStatusBoth("awake"); armAwakeTimeout(); }
    else setStatusBoth("dormant");
  }, [armAwakeTimeout, setStatusBoth]);

  const processUtterance = useCallback(async (blob: Blob) => {
    if (!isActiveRef.current) return;
    setStatusBoth("transcribing");
    try {
      const text = await transcribeBlob(blob);
      setTranscript(text);
      const wasInterrupting = isInterruptingRef.current;
      isInterruptingRef.current = false;
      // Discard empties and known Whisper noise-hallucinations ("Thank you.",
      // "Thanks for watching!", …) so residual noise never reaches the agent.
      if (!text || isHallucinatedTranscript(normalizeSpeech(text))) { backToReady(); return; }

      // Requirement: an interrupting utterance is appended to the previous
      // message and the combined message is submitted again.
      const message = wasInterrupting && lastSubmittedRef.current
        ? `${lastSubmittedRef.current} ${text}`
        : text;
      lastSubmittedRef.current = message;
      await autoSubmit(message);
    } catch (e) {
      showError((e as Error).message);
      backToReady();
    }
  }, [transcribeBlob, autoSubmit, backToReady, showError, setStatusBoth]);

  const processWakeWordClip = useCallback(async (blob: Blob) => {
    if (!isActiveRef.current) return;
    setStatusBoth("transcribing");
    try {
      const raw = await transcribeBlob(blob);
      const norm = normalizeSpeech(raw);
      const wake = normalizeSpeech(configRef.current?.wakeWord ?? "hey bos");

      if (!wake || !norm.includes(wake)) {
        // No wake word — discard and keep waiting.
        if (isActiveRef.current) setStatusBoth("dormant");
        return;
      }

      // Wake word heard — submit the WHOLE utterance (wake word included).
      // "hey bos, check my email" reads naturally to the agent, and a bare
      // "hey bos" gets a spoken reply ("Yes?") instead of a silent state
      // change. The awake window (green mic) arms after the turn resolves.
      awakeRef.current = true;
      setTranscript(raw);
      lastSubmittedRef.current = raw;
      await autoSubmit(raw);
    } catch (e) {
      showError((e as Error).message);
      if (isActiveRef.current) setStatusBoth("dormant");
    }
  }, [transcribeBlob, autoSubmit, showError, setStatusBoth]);

  const handleClip = useCallback((blob: Blob) => {
    const wakeWordMode = configRef.current?.activationMode === "wake-word";
    const isWakeWordClip = wakeWordMode && !awakeRef.current;
    if (isWakeWordClip) void processWakeWordClip(blob);
    else void processUtterance(blob);
  }, [processWakeWordClip, processUtterance]);

  // Speech-onset handling: barge-in decision + status. Shared by both engines.
  // Two interruption intents, decided by how much of the answer the user has
  // actually HEARD:
  //  - still generating, or speaking for < interruptGraceMs → the user is
  //    amending their question: cancel, concatenate, resubmit combined.
  //  - speaking past the grace window → the user heard the answer and is
  //    responding: stop the audio, cancel the rest, submit as a NEW turn.
  const handleSpeechStart = useCallback(() => {
    if (!isActiveRef.current) return;
    if (statusRef.current === "thinking" || statusRef.current === "speaking") {
      const heardMs = speakingStartedAtRef.current !== null
        ? Date.now() - speakingStartedAtRef.current
        : 0;
      const withinGrace = statusRef.current === "thinking" || heardMs < interruptGraceMsRef.current;
      isInterruptingRef.current = withinGrace;
      stopSpeaking();
      const convId = conversationIdRef.current;
      if (convId) void stopRun(convId).catch(() => {});
    }
    if (statusRef.current !== "transcribing") {
      setStatusBoth("listening");
      clearAwakeTimeout(); // don't let the awake window expire mid-utterance
    }
  }, [stopSpeaking, setStatusBoth, clearAwakeTimeout]);

  // ── Session (always-on continuous loop) ─────────────────────────────────────
  //
  // Primary engine: Silero VAD (@ricky0123/vad-web, ONNX in an AudioWorklet).
  // A neural VAD classifies SPEECH probability rather than energy, so ambient
  // noise (keyboards, fans, music, HVAC) no longer triggers spurious
  // utterances the way the old RMS gate did. onSpeechEnd delivers the whole
  // utterance at 16 kHz including pre-speech padding — pre-roll built in.
  //
  // Fallback engine: the original energy/RMS ScriptProcessor ring buffer, used
  // only if the Silero assets (public/vad/, see tools/copy-vad-assets.mjs)
  // fail to load. Degraded (noise-sensitive) but functional.

  const stopSession = useCallback(() => {
    clearAwakeTimeout();
    awakeRef.current = false;
    if (sileroVADRef.current) {
      void sileroVADRef.current.destroy();
      sileroVADRef.current = null;
    }
    if (sessionProcRef.current) {
      sessionProcRef.current.onaudioprocess = null;
      sessionProcRef.current.disconnect();
      sessionProcRef.current = null;
    }
    if (sessionSourceRef.current) {
      sessionSourceRef.current.disconnect();
      sessionSourceRef.current = null;
    }
    if (sessionAudioCtxRef.current) { void sessionAudioCtxRef.current.close().catch(() => {}); sessionAudioCtxRef.current = null; }
    sessionStreamRef.current?.getTracks().forEach((t) => t.stop());
    sessionStreamRef.current = null;
    speechActiveRef.current = false;
    silenceStartRef.current = null;
    forceCommitRef.current = false;
    setStream(null);
  }, [clearAwakeTimeout]);

  // Fallback: energy/RMS VAD over a ScriptProcessor PCM ring buffer.
  const startEnergySession = useCallback((mediaStream: MediaStream) => {
    const ctx = new AudioContext();
    sessionAudioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(mediaStream);
    sessionSourceRef.current = source;
    const proc = ctx.createScriptProcessor(PCM_BUFFER_SIZE, 1, 1);
    sessionProcRef.current = proc;
    source.connect(proc);
    // ScriptProcessor must be connected to run; we never write the output
    // buffer, so nothing is audible (no feedback).
    proc.connect(ctx.destination);

    const sampleRate = ctx.sampleRate;
    const chunkMs = (PCM_BUFFER_SIZE / sampleRate) * 1000;
    const preRollChunks = Math.max(1, Math.ceil(PRE_ROLL_MS / chunkMs));
    const maxChunks = Math.ceil(MAX_UTTERANCE_MS / chunkMs);
    let ring: Float32Array[] = [];

    const commitClip = () => {
      const chunks = ring;
      ring = [];
      speechActiveRef.current = false;
      silenceStartRef.current = null;
      forceCommitRef.current = false;
      if (chunks.length === 0) return;
      handleClip(encodeWAV(chunks, sampleRate));
    };

    proc.onaudioprocess = (e) => {
      if (!isActiveRef.current) return;
      const input = e.inputBuffer.getChannelData(0);
      // Copy — the engine reuses the underlying buffer between callbacks.
      ring.push(new Float32Array(input));
      const rms = pcmRMS(input);
      const speaking = rms >= silenceCeilingRef.current;

      if (!speechActiveRef.current) {
        // Idle: keep only the pre-roll window.
        if (ring.length > preRollChunks) ring.splice(0, ring.length - preRollChunks);
        if (speaking) {
          speechActiveRef.current = true;
          silenceStartRef.current = null;
          handleSpeechStart();
        }
      } else {
        if (forceCommitRef.current || ring.length >= maxChunks) {
          commitClip();
          return;
        }
        if (speaking) {
          silenceStartRef.current = null;
        } else if (silenceStartRef.current === null) {
          silenceStartRef.current = Date.now();
        } else if (Date.now() - silenceStartRef.current >= minSilenceMsRef.current) {
          commitClip();
        }
      }
    };
  }, [handleClip, handleSpeechStart]);

  const startSession = useCallback(async () => {
    if (sessionStreamRef.current || sileroVADRef.current) return;
    try {
      // Primary: Silero neural VAD. Assets are self-hosted under /vad/.
      const { MicVAD } = await import("@ricky0123/vad-web");
      const threshold = configRef.current?.vadThreshold ?? 0.75;
      const vad = await MicVAD.new({
        model: "v5",
        baseAssetPath: "/vad/",
        onnxWASMBasePath: "/vad/",
        getStream: async () => {
          const s = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
          sessionStreamRef.current = s;
          setStream(s);
          return s;
        },
        // vadThreshold IS the Silero speech probability threshold here:
        // higher = stricter = fewer false triggers from ambient noise.
        positiveSpeechThreshold: threshold,
        negativeSpeechThreshold: Math.max(0.05, threshold - 0.15),
        redemptionMs: minSilenceMsRef.current,
        preSpeechPadMs: PRE_ROLL_MS,
        minSpeechMs: 250, // discard sub-250ms blips (clicks, pops) as misfires
        submitUserSpeechOnPause: true, // pause() flushes an in-flight utterance
        startOnLoad: false,
        // React on CONFIRMED speech (past minSpeechMs), not tentative onset —
        // a noise blip must never cancel a running generation.
        onSpeechRealStart: () => handleSpeechStart(),
        onSpeechEnd: (audio: Float32Array) => {
          if (!isActiveRef.current) return;
          handleClip(encodeWAV([audio], 16000));
        },
        onVADMisfire: () => { /* state never changed — nothing to undo */ },
      });
      sileroVADRef.current = vad;
      await vad.start();
    } catch (e) {
      // Fallback: energy VAD (noise-sensitive but dependency-free).
      console.warn("[voice] Silero VAD unavailable, falling back to energy VAD:", (e as Error).message);
      try {
        const mediaStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
        sessionStreamRef.current = mediaStream;
        setStream(mediaStream);
        startEnergySession(mediaStream);
      } catch (micErr) {
        showError(`Microphone error: ${(micErr as Error).message}`);
        setStatusBoth("idle");
        setIsActive(false);
        isActiveRef.current = false;
      }
    }
  }, [startEnergySession, handleClip, handleSpeechStart, showError, setStatusBoth]);

  // ── Push-to-talk (dictation) ────────────────────────────────────────────────

  const stopPTT = useCallback(() => {
    if (ptVADRef.current) { clearInterval(ptVADRef.current); ptVADRef.current = null; }
    if (ptAudioCtxRef.current) { void ptAudioCtxRef.current.close().catch(() => {}); ptAudioCtxRef.current = null; }
    ptSilenceStartRef.current = null;
    const rec = ptRecRef.current;
    if (!rec || rec.recorder.state === "inactive") return;
    ptRecRef.current = null;
    ptStreamRef.current?.getTracks().forEach((t) => t.stop());
    ptStreamRef.current = null;
    setStream(null);

    const mimeType = rec.recorder.mimeType || "audio/webm";
    rec.recorder.onstop = async () => {
      setStatusBoth("transcribing");
      try {
        const blob = new Blob(rec.chunks, { type: mimeType });
        const text = await transcribeBlob(blob);
        setTranscript(text);
        onTranscriptRef.current?.(text);
      } catch (e) {
        showError((e as Error).message);
      } finally {
        setStatusBoth("idle");
      }
    };
    rec.recorder.stop();
  }, [transcribeBlob, showError, setStatusBoth]);

  const startListening = useCallback(async () => {
    if (statusRef.current === "listening") return;
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
      ptStreamRef.current = mediaStream;
      setStream(mediaStream);

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(mediaStream, { mimeType });
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.start(100);
      ptRecRef.current = { recorder, chunks };
      setStatusBoth("listening");

      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(mediaStream).connect(analyser);
      ptAudioCtxRef.current = ctx;
      const startedAt = Date.now();

      ptVADRef.current = setInterval(() => {
        if (Date.now() - startedAt < PTT_MIN_RECORDING_MS) return;
        const rms = measureRMS(analyser);
        if (rms < silenceCeilingRef.current) {
          if (ptSilenceStartRef.current === null) ptSilenceStartRef.current = Date.now();
          else if (Date.now() - ptSilenceStartRef.current > minSilenceMsRef.current) {
            stopPTT();
          }
        } else {
          ptSilenceStartRef.current = null;
        }
      }, VAD_POLL_INTERVAL_MS);
    } catch (e) {
      showError(`Microphone error: ${(e as Error).message}`);
    }
  }, [stopPTT, showError, setStatusBoth]);

  const stopListening = useCallback(() => {
    if (isActiveRef.current) {
      // Session mode: force-commit the in-flight recording as an utterance.
      const vad = sileroVADRef.current;
      if (vad) {
        // pause() flushes the current segment to onSpeechEnd
        // (submitUserSpeechOnPause: true), then listening resumes.
        void vad.pause().then(() => { if (isActiveRef.current) void vad.start(); });
      } else {
        forceCommitRef.current = true; // energy fallback path
      }
    } else {
      stopPTT();
    }
  }, [stopPTT]);

  // ── Activate / deactivate ───────────────────────────────────────────────────

  const activate = useCallback(() => {
    isActiveRef.current = true;
    setIsActive(true);
    setStatusBoth("dormant");
    void startSession();
  }, [startSession, setStatusBoth]);

  const deactivate = useCallback(() => {
    isActiveRef.current = false;
    setIsActive(false);
    stopSpeaking();
    stopSession();
    lastSubmittedRef.current = "";
    isInterruptingRef.current = false;
    speakingStartedAtRef.current = null;
    streamSnapshotRef.current = "";
    spokenLenRef.current = 0;
    prevRunningRef.current = false;
    setStatusBoth("idle");
  }, [stopSpeaking, stopSession, setStatusBoth]);

  // ── Sentence-streaming TTS + turn lifecycle (session mode) ──────────────────
  //
  // Tracks a spoken-length cursor over a snapshot of the live stream text.
  // The chat store CLEARS streamText when a message finalizes (mid-run and at
  // run end), so the snapshot — not streamText itself — is the source of truth
  // for what remains to be spoken. Every character of every reply is spoken:
  // complete sentences stream out as they arrive; the remainder flushes when
  // the message finalizes or the run ends.

  const flushRemainder = useCallback(() => {
    const rest = streamSnapshotRef.current.slice(spokenLenRef.current).trim();
    streamSnapshotRef.current = "";
    spokenLenRef.current = 0;
    if (rest && speakRepliesRef.current) speak(rest);
  }, [speak]);

  useEffect(() => {
    runningRef.current = chatState.running;
    if (!isActive) return;
    const running = chatState.running;
    const text = chatState.streamText ?? "";

    // 1) Stream buffer reset (message finalized) — speak the unspoken
    //    remainder of the previous snapshot before tracking the new stream.
    if (text.length < streamSnapshotRef.current.length) {
      flushRemainder();
    }

    // 2) New text — queue complete sentences beyond the spoken cursor.
    if (text !== streamSnapshotRef.current) {
      streamSnapshotRef.current = text;
      const unspoken = text.slice(spokenLenRef.current);
      const { complete, remainder } = splitSentences(unspoken, 2);
      if (complete.length) {
        spokenLenRef.current += unspoken.length - remainder.length;
        if (speakRepliesRef.current) for (const sentence of complete) speak(sentence);
      }
    }

    // 3) Run finished — flush the tail and restore the ready state.
    if (!running && prevRunningRef.current) {
      flushRemainder();
      if (pendingTTSRef.current === 0) restoreReadyStatus();
    }
    prevRunningRef.current = running;
  }, [chatState.streamText, chatState.running, isActive, speak, flushRemainder, restoreReadyStatus]);

  // ── Cleanup on unmount ──────────────────────────────────────────────────────
  // The teardown MUST be unmount-only. With teardown functions in the dep
  // array, any identity change re-fires the cleanup and kills a live session
  // mid-conversation (this exact bug silenced TTS and deafened the mic).
  // The functions are reached through a ref so the dep array can stay empty.

  const teardownRef = useRef<() => void>(() => {});
  useEffect(() => {
    teardownRef.current = () => {
      stopSpeaking();
      stopSession();
      stopPTT();
    };
  });
  useEffect(() => () => teardownRef.current(), []);

  return {
    status,
    transcript,
    error,
    stream,
    config,
    activationMode: config?.activationMode ?? "button",
    isEnabled: config?.enabled ?? false,
    isActive,
    startListening,
    stopListening,
    speak,
    stopSpeaking,
    activate,
    deactivate,
    reloadConfig,
  };
}
