import "server-only";
import type { VoiceConfig } from "./types";

export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string,
  cfg: VoiceConfig,
): Promise<{ transcript: string }> {
  const form = new FormData();
  const ext = mimeType.includes("wav") ? "wav" : mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
  // Wrap in a Uint8Array view: a Node Buffer isn't assignable to DOM BlobPart.
  const blob = new Blob([new Uint8Array(audioBuffer)], { type: mimeType });
  form.append("file", blob, `audio.${ext}`);
  form.append("model", cfg.sttModel);
  form.append("language", cfg.language);
  form.append("response_format", "json");

  const res = await fetch(`${cfg.sttUrl}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Speaches STT error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { text?: string; transcript?: string };
  const transcript = data.text ?? data.transcript ?? "";
  return { transcript };
}
