"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useChatState } from "@/lib/assistant/client/chat-store";
import { VoiceOverlay } from "./VoiceOverlay";
import type { VoiceConfig, VoiceStatus } from "@/lib/voice/types";

function extractCompleteSentences(text: string, minLen: number): { sentences: string[]; remainder: string } {
  const sentences: string[] = [];
  const regex = /[.!?…]+(?:\s+|$)/g;
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const end = match.index + match[0].length;
    const candidate = text.slice(lastEnd, end).trim();
    if (candidate.length >= minLen) { sentences.push(candidate); lastEnd = end; }
  }
  return { sentences, remainder: text.slice(lastEnd) };
}

interface VoiceTTSPlayerProps {
  conversationId: string;
}

export function VoiceTTSPlayer({ conversationId }: VoiceTTSPlayerProps) {
  const state = useChatState(conversationId);
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  const [ttsStatus, setTtsStatus] = useState<VoiceStatus>("idle");

  const bufferRef = useRef("");
  const prevStreamTextRef = useRef("");
  const ttsQueueRef = useRef<Promise<void>>(Promise.resolve());
  const abortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const prevRunningRef = useRef(false);

  useEffect(() => {
    fetch("/api/voice")
      .then((r) => r.json())
      .then((data: { config?: VoiceConfig }) => { if (data.config) setConfig(data.config); })
      .catch(() => {});
  }, []);

  // In always-on (wake-word) mode, TTS is coordinated inside useVoice (for
  // interruption support). This component only handles passive / button-mode TTS.
  const passiveTTS = config?.enabled && config.activationMode !== "wake-word" && config.speakReplies !== false;

  const speakSegment = useCallback(async (text: string) => {
    if (!text.trim()) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setTtsStatus("speaking");
    try {
      const res = await fetch("/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: abort.signal,
      });
      if (!res.ok || abort.signal.aborted) return;
      const blob = await res.blob();
      if (abort.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      await new Promise<void>((resolve) => {
        audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
        audio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
        abort.signal.addEventListener("abort", () => { audio.pause(); URL.revokeObjectURL(url); resolve(); });
        void audio.play().catch(resolve);
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") { /* non-fatal */ }
    } finally {
      if (!abort.signal.aborted) setTtsStatus("idle");
    }
  }, []);

  const enqueue = useCallback((text: string) => {
    ttsQueueRef.current = ttsQueueRef.current.then(() => speakSegment(text));
  }, [speakSegment]);

  useEffect(() => {
    if (!passiveTTS || !state.running) return;
    const currentText = state.streamText ?? "";
    const prevText = prevStreamTextRef.current;
    if (currentText.length <= prevText.length) {
      if (currentText.length < prevText.length) { prevStreamTextRef.current = currentText; bufferRef.current = ""; }
      return;
    }
    const delta = currentText.slice(prevText.length);
    prevStreamTextRef.current = currentText;
    bufferRef.current += delta;
    const { sentences, remainder } = extractCompleteSentences(bufferRef.current, 2);
    bufferRef.current = remainder;
    for (const s of sentences) enqueue(s);
  }, [state.streamText, state.running, passiveTTS, config, enqueue]);

  useEffect(() => {
    if (!passiveTTS) return;
    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = state.running;
    if (wasRunning && !state.running) {
      const remaining = bufferRef.current.trim();
      bufferRef.current = "";
      prevStreamTextRef.current = "";
      if (remaining) enqueue(remaining);
    }
  }, [state.running, passiveTTS, enqueue]);

  if (!passiveTTS || ttsStatus === "idle") return null;

  return <VoiceOverlay status={ttsStatus} className="absolute right-3 bottom-16 z-20" />;
}
