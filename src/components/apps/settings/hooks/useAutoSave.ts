"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type AutoSaveStatus = "idle" | "saving" | "saved" | "error";

export interface UseAutoSaveOptions {
  /** How long the "saved" state persists before reverting to "idle". Default 2000ms. */
  savedDelayMs?: number;
}

export interface UseAutoSaveResult<P> {
  status: AutoSaveStatus;
  error: Error | null;
  /**
   * Queue a save. At most one request is in flight at a time; while one is
   * running, the most recent patch supplied here replaces any earlier queued
   * patch — rapid calls coalesce to a single follow-up write.
   */
  save: (patch: P) => void;
}

/**
 * Reusable auto-save hook for settings forms. Callers decide when to trigger:
 * `onBlur={() => save(value)}` for text inputs, `onChange={() => save(next)}`
 * for checkboxes. Exposes a status the AutoSaveStatus component can render.
 */
export function useAutoSave<P>(
  onSave: (patch: P) => Promise<void>,
  options: UseAutoSaveOptions = {},
): UseAutoSaveResult<P> {
  const { savedDelayMs = 2000 } = options;

  const [status, setStatus] = useState<AutoSaveStatus>("idle");
  const [error, setError] = useState<Error | null>(null);

  // Latest onSave without retriggering effects.
  const onSaveRef = useRef(onSave);
  const inFlightRef = useRef(false);
  const pendingRef = useRef<{ patch: P } | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    onSaveRef.current = onSave;
  });

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const drain = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      while (pendingRef.current) {
        const { patch } = pendingRef.current;
        pendingRef.current = null;
        if (mountedRef.current) setStatus("saving");
        try {
          await onSaveRef.current(patch);
          if (!mountedRef.current) return;
          setError(null);
          // Only flip to "saved" when nothing new was queued mid-flight —
          // otherwise loop straight into the next save without a stale flash.
          if (!pendingRef.current) {
            setStatus("saved");
            if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
            savedTimerRef.current = setTimeout(() => {
              if (mountedRef.current) setStatus("idle");
            }, savedDelayMs);
          }
        } catch (e) {
          if (!mountedRef.current) return;
          setStatus("error");
          setError(e instanceof Error ? e : new Error(String(e)));
        }
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [savedDelayMs]);

  const save = useCallback(
    (patch: P) => {
      pendingRef.current = { patch };
      if (savedTimerRef.current) {
        clearTimeout(savedTimerRef.current);
        savedTimerRef.current = null;
      }
      void drain();
    },
    [drain],
  );

  return { status, error, save };
}
