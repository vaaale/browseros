"use client";

import { useSyncExternalStore } from "react";

// 045 US3 (ADR-2, option B): card-LOCAL collapse state for the per-card
// collapsible units — the card HEADER (nested cards only), the Input section,
// and the Output section — each independently toggleable and defaulting to
// COLLAPSED when the card first opens (FR-015).
//
// This is deliberately a SEPARATE, private, module-side map — NOT the shared
// src/lib/agent/card-collapse.ts registry (which stays strictly the cross-card
// header accordion shared with the reasoning cards). Keeping section state out of
// the shared registry is the lower-risk choice (design Risk 7): it leaves
// registerCard/toggleCard/useCardOpen semantics — and the reasoning cards that
// depend on them — completely untouched.
//
// Module-side (not React) so state survives the frequent remounts the card
// undergoes while a turn is still streaming — the same rationale as card-collapse.
// State is keyed by callId; a nested child card uses its own (synthetic) callId,
// so its header/sections are independent of the parent's and of each other.

export type ToolCardSection = "header" | "input" | "output";

interface Flags {
  header: boolean;
  input: boolean;
  output: boolean;
}

const DEFAULTS: Flags = { header: false, input: false, output: false };

const flagsByCall = new Map<string, Flags>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function flagsFor(callId: string): Flags {
  let f = flagsByCall.get(callId);
  if (!f) {
    f = { ...DEFAULTS };
    flagsByCall.set(callId, f);
  }
  return f;
}

export function getSectionOpen(callId: string, section: ToolCardSection): boolean {
  return flagsByCall.get(callId)?.[section] ?? DEFAULTS[section];
}

export function setSectionOpen(callId: string, section: ToolCardSection, open: boolean): void {
  const f = flagsFor(callId);
  if (f[section] === open) return;
  f[section] = open;
  emit();
}

export function toggleSection(callId: string, section: ToolCardSection): void {
  setSectionOpen(callId, section, !getSectionOpen(callId, section));
}

// The Input section's raw/structured view toggle (FR-013). Separate from the
// section open flags — it is a view preference, defaulting to structured.
const rawByCall = new Map<string, boolean>();

export function isInputRaw(callId: string): boolean {
  return rawByCall.get(callId) ?? false;
}

export function toggleInputRaw(callId: string): void {
  rawByCall.set(callId, !isInputRaw(callId));
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** React binding. Safe under SSR (server snapshot is always the default). */
export function useSectionOpen(callId: string, section: ToolCardSection): boolean {
  return useSyncExternalStore(subscribe, () => getSectionOpen(callId, section), () => DEFAULTS[section]);
}

export function useInputRaw(callId: string): boolean {
  return useSyncExternalStore(subscribe, () => isInputRaw(callId), () => false);
}
