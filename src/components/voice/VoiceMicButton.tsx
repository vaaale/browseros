"use client";

import { useCallback, useState } from "react";
import { Mic, ChevronDown, Volume2, VolumeX, Video, VideoOff } from "lucide-react";
import { useVoice } from "@/hooks/useVoice";
import { usePresenceEngine, patchVoiceConfig } from "@/lib/voice/client/config-store";
import { VoiceActivationPopover } from "./VoiceActivationPopover";
import { VoiceWaveform } from "./VoiceWaveform";
import type { VoiceConfig } from "@/lib/voice/types";

interface VoiceMicButtonProps {
  conversationId: string;
  agentId: string;
  onTranscript?: (text: string) => void;
  ensureConversation?: () => Promise<string>;
  className?: string;
}

export function VoiceMicButton({ conversationId, agentId, onTranscript, ensureConversation, className }: VoiceMicButtonProps) {
  const {
    status,
    stream,
    config,
    error,
    isActive,
    voiceOutput,
    setVoiceOutput,
    startListening,
    stopListening,
    stopSpeaking,
    activate,
    deactivate,
  } = useVoice({ conversationId, agentId, onTranscript, ensureConversation });

  // No engine can show a face → no video button at all (036 FR-006).
  const presenceEngine = usePresenceEngine();
  const [showPopover, setShowPopover] = useState(false);

  const isWakeWordMode = config?.activationMode === "wake-word";
  const isKeyMode = config?.activationMode === "key";
  const isSessionMode = isWakeWordMode || isKeyMode;
  const isListening = status === "listening";
  const isTranscribing = status === "transcribing";
  const isSpeaking = status === "speaking";
  const isDormant = status === "dormant";
  const isAwake = status === "awake";
  const speaks = voiceOutput !== "off";
  const showsFace = voiceOutput === "avatar";

  const handleMicClick = useCallback(async () => {
    if (isListening) { stopListening(); return; }
    if (isSpeaking) { stopSpeaking(); return; }
    if (isTranscribing) return;

    if (isSessionMode) {
      if (isActive || isDormant || isAwake) deactivate();
      else activate();
    } else {
      await startListening();
    }
  }, [isListening, isSpeaking, isTranscribing, isSessionMode, isActive, isDormant, isAwake, deactivate, activate, startListening, stopListening, stopSpeaking]);

  // Output is one setting with three values, so these two buttons cannot
  // disagree: there is no "face on screen, sound off" to represent (036 FR-003).
  const handleSpeakerClick = useCallback(() => {
    void setVoiceOutput(voiceOutput === "off" ? "audio" : "off");
  }, [voiceOutput, setVoiceOutput]);

  const handleVideoClick = useCallback(() => {
    void setVoiceOutput(voiceOutput === "avatar" ? "audio" : "avatar");
  }, [voiceOutput, setVoiceOutput]);

  // Through the store, not a bare fetch: one write path means every consumer sees
  // the change at once and nobody is left holding a stale copy.
  const handleConfigChange = useCallback(async (patch: Partial<VoiceConfig>) => {
    await patchVoiceConfig(patch);
  }, []);

  // Visual state
  const micColor = (() => {
    if (isListening) return "bg-rose-500/20 text-rose-400 hover:bg-rose-500/30";
    if (isAwake) return "bg-emerald-500/25 text-emerald-400 hover:bg-emerald-500/35 animate-pulse";
    if (isSpeaking) return "bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30";
    if (isDormant) return "bg-blue-500/15 text-blue-400 hover:bg-blue-500/25";
    return "text-white/40 hover:bg-white/10 hover:text-white/70";
  })();

  const ariaLabel = (() => {
    if (isListening) return "Stop recording";
    if (isAwake) return "Listening — click to deactivate";
    if (isSpeaking) return "Stop speaking";
    if (isKeyMode && (isActive || isDormant || isAwake)) return "Stop key-to-talk";
    if (isKeyMode) return "Start key-to-talk";
    if (isWakeWordMode && (isActive || isDormant || isAwake)) return "Stop always-on listening";
    if (isWakeWordMode) return "Start always-on listening";
    return "Start voice input";
  })();

  const activationKey = config?.activationKey || "ControlLeft";
  const title = (() => {
    if (isListening) return isKeyMode ? "Recording — release the key to submit" : "Recording — click to stop";
    if (isAwake) return `Awake — listening for your message (${config?.wakeWord ?? "hey bos"} heard)`;
    if (isSpeaking) return "Speaking — click to stop";
    if (isDormant && isKeyMode) return `Key-to-talk — hold ${activationKey} to record`;
    if (isDormant) return `Always-on — waiting for "${config?.wakeWord ?? "hey bos"}"`;
    if (isKeyMode) return `Click to start key-to-talk (hold ${activationKey})`;
    if (isWakeWordMode) return "Click to start always-on listening";
    return "Click to speak";
  })();

  return (
    <div className={`relative flex items-center gap-0.5 ${className ?? ""}`}>
      {error && (
        <div className="absolute bottom-full left-0 z-50 mb-1 max-w-[280px] rounded-md border border-rose-500/30 bg-rose-950/95 px-2 py-1 text-[11px] text-rose-200 shadow-lg">
          {error}
        </div>
      )}
      <button
        type="button"
        aria-label={ariaLabel}
        title={title}
        onClick={() => void handleMicClick()}
        disabled={isTranscribing}
        className={`rounded-lg p-1.5 transition-colors disabled:opacity-50 ${micColor}`}
      >
        {isTranscribing ? (
          <span className="inline-block h-[15px] w-[15px] animate-spin rounded-full border-2 border-white/20 border-t-amber-400" />
        ) : (
          <Mic size={15} />
        )}
      </button>

      <button
        type="button"
        aria-label={speaks ? "Turn off spoken replies" : "Speak replies aloud"}
        aria-pressed={speaks}
        title={speaks ? "Spoken replies on — click to mute" : "Spoken replies off — click to hear replies"}
        data-testid="voice-speaker-toggle"
        onClick={handleSpeakerClick}
        disabled={!config}
        className={`rounded-lg p-1.5 transition-colors disabled:opacity-40 ${
          isSpeaking
            ? "bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30"
            : speaks
              ? "text-emerald-400/80 hover:bg-white/10 hover:text-emerald-300"
              : "text-white/40 hover:bg-white/10 hover:text-white/70"
        }`}
      >
        {speaks ? <Volume2 size={15} /> : <VolumeX size={15} />}
      </button>

      {presenceEngine && (
        <button
          type="button"
          aria-label={showsFace ? "Turn off the avatar" : "Show the avatar and speak replies"}
          aria-pressed={showsFace}
          title={showsFace
            ? `${presenceEngine.surface?.label ?? "Avatar"} on — click to keep audio only`
            : `Show ${presenceEngine.surface?.label ?? "the avatar"} and speak replies aloud`}
          data-testid="voice-video-toggle"
          onClick={handleVideoClick}
          disabled={!config}
          className={`rounded-lg p-1.5 transition-colors disabled:opacity-40 ${
            showsFace
              ? "text-emerald-400/80 hover:bg-white/10 hover:text-emerald-300"
              : "text-white/40 hover:bg-white/10 hover:text-white/70"
          }`}
        >
          {showsFace ? <Video size={15} /> : <VideoOff size={15} />}
        </button>
      )}

      {isListening && stream && (
        <VoiceWaveform stream={stream} active={true} width={48} height={18} className="opacity-80" />
      )}

      <button
        type="button"
        aria-label="Voice options"
        onClick={() => setShowPopover((v) => !v)}
        className="rounded p-0.5 text-white/20 transition-colors hover:text-white/50"
      >
        <ChevronDown size={10} />
      </button>

      {showPopover && (
        <VoiceActivationPopover
          config={config}
          onConfigChange={(patch) => void handleConfigChange(patch)}
          onClose={() => setShowPopover(false)}
        />
      )}
    </div>
  );
}
