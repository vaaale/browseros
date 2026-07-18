import { NextResponse } from "next/server";
import { loadVoiceConfig } from "@/lib/voice/config";

export const dynamic = "force-dynamic";

// Built-in OpenAI-compatible voice aliases Omnivoice always accepts.
const BUILTIN_ALIASES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

// Omnivoice endpoints return voices/speakers in a few possible shapes
// (array of strings, array of {name|id}, or {voices:[...]}). Normalize any of
// them into a flat list of voice-name strings.
function extractNames(payload: unknown): string[] {
  const arr = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { voices?: unknown[] })?.voices)
      ? (payload as { voices: unknown[] }).voices
      : Array.isArray((payload as { speakers?: unknown[] })?.speakers)
        ? (payload as { speakers: unknown[] }).speakers
        : [];
  const names: string[] = [];
  for (const item of arr) {
    if (typeof item === "string") names.push(item);
    else if (item && typeof item === "object") {
      const o = item as { name?: unknown; id?: unknown; voice?: unknown };
      const n = o.name ?? o.id ?? o.voice;
      if (typeof n === "string") names.push(n);
    }
  }
  return names;
}

export async function GET() {
  const cfg = await loadVoiceConfig();
  const baseUrl = cfg.omnivoice.url;

  // Saved voice profiles + built-in aliases. Reachability is best-effort:
  // if Omnivoice is down we still return the built-in aliases so the dropdown
  // is never empty.
  let profiles: string[] = [];
  try {
    const res = await fetch(`${baseUrl}/tts/voices`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) profiles = extractNames(await res.json());
  } catch {
    /* unreachable — fall back to built-ins only */
  }

  // Dedupe, aliases first, then any custom profiles.
  const seen = new Set<string>();
  const voices: string[] = [];
  for (const v of [...BUILTIN_ALIASES, ...profiles]) {
    const t = v.trim();
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); voices.push(t); }
  }

  return NextResponse.json({ voices, profiles });
}
