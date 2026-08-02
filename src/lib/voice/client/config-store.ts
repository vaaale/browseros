"use client";

// ONE client-side copy of the voice config, shared by every consumer: the mic
// button, the Assistant's output toggles, the Settings tab and the presence host.
//
// Each of those used to fetch `/api/voice` for itself and hold the result in its
// own state, refreshed only when that component happened to refresh it. Two such
// copies disagreeing is what let TTS run with the setting off (033 §9a), and a
// third copy would decide whether the avatar is on screen. One store, one fetch,
// one patch path — everyone re-renders together.

import { useSyncExternalStore } from "react";
import type { VoiceConfig } from "../types";

export interface VoiceEngineInfo {
  id: string;
  displayName: string;
  configSchema?: Record<string, unknown> | null;
  /** Present when the engine has a visual presence BOS can host (036). */
  surface?: { url: string; label?: string };
}

interface VoiceSnapshot {
  config: VoiceConfig | null;
  engines: VoiceEngineInfo[];
}

let snapshot: VoiceSnapshot = { config: null, engines: [] };
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): VoiceSnapshot {
  return snapshot;
}

function setSnapshot(next: Partial<VoiceSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  notify();
}

/** Fetch the config + engine list. Concurrent callers share one request. */
export function loadVoiceConfig(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = fetch("/api/voice")
    .then((r) => r.json())
    .then((data: { config?: VoiceConfig; engines?: VoiceEngineInfo[] }) => {
      setSnapshot({
        config: data.config ?? snapshot.config,
        engines: data.engines ?? snapshot.engines,
      });
    })
    .catch(() => { /* non-fatal: consumers keep the previous snapshot */ })
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** Persist a patch and adopt the server's merged result as the new truth. */
export async function patchVoiceConfig(patch: Partial<VoiceConfig>): Promise<VoiceConfig | null> {
  const res = await fetch("/api/voice", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patch }),
  }).then((r) => r.json() as Promise<{ config?: VoiceConfig; error?: string }>);
  if (res.error) throw new Error(res.error);
  if (res.config) setSnapshot({ config: res.config });
  return res.config ?? null;
}

export function getVoiceConfig(): VoiceConfig | null {
  return snapshot.config;
}

function useVoiceSnapshot(): VoiceSnapshot {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!snap.config && !inFlight) void loadVoiceConfig();
  return snap;
}

export function useVoiceConfig(): VoiceConfig | null {
  return useVoiceSnapshot().config;
}

export function useVoiceEngines(): VoiceEngineInfo[] {
  return useVoiceSnapshot().engines;
}

/** The engine that can render the agent visually, if any (036 FR-009). Chosen
 *  independently of `ttsProvider` — the avatar renders audio from whichever
 *  engine synthesized it, as an audio sink. */
export function usePresenceEngine(): VoiceEngineInfo | null {
  return useVoiceSnapshot().engines.find((e) => e.surface?.url) ?? null;
}
