import "server-only";
import { registerRunHooks } from "@/lib/assistant/hooks";
import { loadVoiceConfig } from "./config";

let registered = false;

export function registerVoiceModeHook(): void {
  if (registered) return;
  registered = true;

  registerRunHooks("voice-mode", {
    extendSystemPrompt: async () => {
      try {
        const cfg = await loadVoiceConfig();
        if (!cfg.enabled) return undefined;

        // "Speak mode" = replies are synthesized and spoken aloud (TTS on).
        // When off, voice is input-only (dictation → text reply).
        const speakMode = cfg.speakReplies !== false;

        // A stable, greppable status line the user can key their own agent
        // instructions off (e.g. "When VOICE MODE is active and replies are
        // spoken, keep answers under three sentences."). Keep these tokens
        // stable — users' prompts may depend on them.
        const statusLine = `[VOICE MODE: active | Spoken replies: ${speakMode ? "on" : "off"} | Wake phrase: "${cfg.wakeWord}"]`;

        const guidance = [
          "You are interacting with the user through voice mode.",
          `The user may address you with the wake phrase "${cfg.wakeWord}" (speech-to-text may spell it differently, e.g. "hey boss").`,
          "Treat the wake phrase as being addressed directly — do not comment on it.",
          "If a message consists of only the wake phrase, reply with a very short acknowledgement asking what they need (e.g. \"Yes? How can I help?\").",
        ];

        if (speakMode) {
          guidance.push(
            "Your replies are spoken aloud. Be concise and natural. Avoid markdown formatting,",
            "bullet lists, numbered lists, code blocks, and headers unless the user explicitly asks for them.",
            "Speak in complete sentences. Keep responses brief and conversational.",
          );
        } else {
          guidance.push("Your replies are shown as text (not spoken), but the user's input arrives by voice, so expect conversational phrasing and possible transcription quirks.");
        }

        return `${statusLine}\n${guidance.join(" ")}`;
      } catch {
        return undefined;
      }
    },
  });
}
