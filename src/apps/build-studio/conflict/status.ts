import type { SessionStatus } from "@/lib/gitops/sessions/types";

// The pane's visual language, kept in one place so the status pill, the file
// chips, the banner, and the chat header can never drift out of agreement.
// Mirrors the accepted mockup's STATUS_META (mockup.html), which is the
// binding UI contract for this pane (D8).

export interface StatusMeta {
  label: string;
  short: string;
  /** Tailwind classes for the pill: text + background + border. */
  pill: string;
  /** Tailwind text colour for the status dot. */
  dot: string;
  /** Whether the dot pulses — the two live states (D6). */
  pulsing: boolean;
}

export const STATUS_META: Record<SessionStatus, StatusMeta> = {
  working: {
    label: "Agent resolving",
    short: "working",
    pill: "text-sky-300 bg-sky-500/10 border-sky-400/35",
    dot: "text-sky-400",
    pulsing: true,
  },
  "awaiting-user": {
    label: "Awaiting your decision",
    short: "awaiting-user",
    pill: "text-amber-300 bg-amber-500/15 border-amber-400/45",
    dot: "text-amber-400",
    pulsing: true,
  },
  resolved: {
    label: "Resolved — operation complete",
    short: "resolved",
    pill: "text-emerald-300 bg-emerald-500/15 border-emerald-400/40",
    dot: "text-emerald-400",
    pulsing: false,
  },
  failed: {
    label: "Failed",
    short: "failed",
    pill: "text-red-300 bg-red-500/15 border-red-400/45",
    dot: "text-red-400",
    pulsing: false,
  },
  "timed-out": {
    label: "Timed out (25 min)",
    short: "timed-out",
    pill: "text-red-300 bg-red-500/15 border-red-400/45",
    dot: "text-red-400",
    pulsing: false,
  },
  abandoned: {
    label: "Rolled back — operation aborted",
    short: "abandoned",
    pill: "text-white/60 bg-white/[0.06] border-white/15",
    dot: "text-white/40",
    pulsing: false,
  },
};

export function baseName(p: string): string {
  return p.split("/").pop() || p;
}
