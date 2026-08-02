"use client";

import { useEffect, useRef } from "react";
import { useOSStore } from "@/store/os-provider";
import { useVoiceConfig, usePresenceEngine, patchVoiceConfig } from "@/lib/voice/client/config-store";

// Turns the voice-output intent into a window (036). Mounted on the desktop, not
// inside the Assistant, for two reasons: the face must be able to appear with no
// Assistant window open, and there must be exactly one thing deciding whether it
// is on screen.

const HEIGHT_FRACTION = 0.25;
const INSET_FRACTION = 0.08;
const TOPBAR_H = 32;
/** Square first guess — the surface's real aspect replaces it on the first video
 *  frame (PresenceApp.applyAspect). Neutral on purpose: guessing portrait makes
 *  the window too narrow to read a connection error in. */
const PROVISIONAL_RATIO = 1;

// Per page load, not per mount: a fresh load must not restore a face, because
// BOS restores no windows and reconnects nothing (FR-005).
let demoteDecided = false;

function placement(): { width: number; height: number; x: number; y: number } {
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const height = Math.round((vh - TOPBAR_H) * HEIGHT_FRACTION);
  return {
    width: Math.round(height * PROVISIONAL_RATIO),
    height,
    x: Math.round(vw * INSET_FRACTION),
    y: TOPBAR_H + Math.round(vh * INSET_FRACTION),
  };
}

export function PresenceHost() {
  const config = useVoiceConfig();
  const engine = usePresenceEngine();
  const presenceWindow = useOSStore((s) => s.windows.find((w) => w.appId === "presence"));
  const launch = useOSStore((s) => s.launch);
  const close = useOSStore((s) => s.close);
  const openedRef = useRef(false);

  const mode = config?.voiceOutput ?? "off";
  const surfaceUrl = engine?.surface?.url;

  useEffect(() => {
    if (!config || demoteDecided) return;
    demoteDecided = true;
    if (config.voiceOutput === "avatar") void patchVoiceConfig({ voiceOutput: "audio" });
  }, [config]);

  useEffect(() => {
    if (!config || !demoteDecided) return;

    if (mode === "avatar" && surfaceUrl && engine) {
      if (!presenceWindow && !openedRef.current) {
        launch(
          "presence",
          { engineId: engine.id, url: surfaceUrl, label: engine.surface?.label ?? engine.displayName },
          placement(),
        );
        openedRef.current = true;
      } else if (!presenceWindow && openedRef.current) {
        // The window was closed from its own title bar — the intent follows the
        // screen, so the button can never claim a face that isn't there (FR-004).
        openedRef.current = false;
        void patchVoiceConfig({ voiceOutput: "audio" });
      }
      return;
    }

    if (presenceWindow) {
      close(presenceWindow.id);
      openedRef.current = false;
    }
  }, [config, mode, engine, surfaceUrl, presenceWindow, launch, close]);

  return null;
}
