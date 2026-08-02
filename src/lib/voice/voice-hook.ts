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
        // Spoken replies are the one thing the server can know for certain, and
        // the only one that changes how a reply should be WRITTEN. Whether the
        // user is dictating is client-side state we deliberately don't guess at.
        if (cfg.voiceOutput === "off") return undefined;

        // A stable, greppable status line the user can key their own agent
        // instructions off (e.g. "When replies are spoken, keep answers under
        // three sentences."). Keep these tokens stable — users' prompts may
        // depend on them.
        const statusLine = `[VOICE MODE: active | Spoken replies: on | Wake phrase: "${cfg.wakeWord}"]`;

        const guidance = [
          "Your replies are spoken aloud. Be concise and natural. Avoid markdown formatting,",
          "bullet lists, numbered lists, code blocks, and headers unless the user explicitly asks for them.",
          "Speak in complete sentences. Keep responses brief and conversational.",
          `If the user addresses you with the wake phrase "${cfg.wakeWord}" (speech-to-text may spell it differently, e.g. "hey boss"), treat it as being addressed directly — do not comment on it.`,
          "If a message consists of only the wake phrase, reply with a very short acknowledgement asking what they need (e.g. \"Yes? How can I help?\").",
        ];

        return `${statusLine}\n${guidance.join(" ")}`;
      } catch {
        return undefined;
      }
    },
  });
}
