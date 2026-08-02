"use client";

// Whether the agent is speaking RIGHT NOW, published by the one TTS producer
// (useVoice) and read by anything that has to react to it — currently the
// presence window, which forwards it to the surface so a face can animate while
// it talks (036 FR-012).
//
// A store rather than a prop because the presence window is not inside the
// Assistant's tree: it is a separate window, and later a separate trigger
// entirely (an incoming email making the agent speak up).

import { useSyncExternalStore } from "react";

let speaking = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setAgentSpeaking(value: boolean): void {
  if (speaking === value) return;
  speaking = value;
  for (const l of listeners) l();
}

function getSnapshot(): boolean {
  return speaking;
}

function getServerSnapshot(): boolean {
  return false;
}

export function useAgentSpeaking(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
