// Presence lease (036 FR-013).
//
// An engine's audio sink swallows every utterance: the TTS route hands the audio
// to the sink and withholds the data URL so the browser doesn't speak it twice.
// That is correct only while the sink is genuinely rendering. Gating it on "the
// plugin holds a socket" was not: closing the avatar's window left the socket
// open, so replies went to a face nobody could see and the assistant fell silent
// with no error.
//
// So liveness is a LEASE the renderer keeps proving, not a state a socket
// implies. BOS's presence window renews it while its surface reports media is
// playing; if the window closes, crashes, or the media never starts, nothing
// renews it and it expires on its own. Audio falls back to the browser.

const KEY = "__bos_presence_lease__" as const;

/** Long enough to survive a slow renew, short enough that a dead surface stops
 *  intercepting audio within one reply. */
export const PRESENCE_LEASE_TTL_MS = 12_000;

interface Lease {
  engineId: string;
  sessionId: string;
  expiresAt: number;
}

function slot(): { lease: Lease | null } {
  const g = globalThis as Record<string, unknown>;
  if (!g[KEY]) g[KEY] = { lease: null };
  return g[KEY] as { lease: Lease | null };
}

export function renewPresenceLease(engineId: string, sessionId: string): void {
  slot().lease = { engineId, sessionId, expiresAt: Date.now() + PRESENCE_LEASE_TTL_MS };
}

export function releasePresenceLease(engineId?: string): void {
  const s = slot();
  if (!engineId || s.lease?.engineId === engineId) s.lease = null;
}

export function isPresenceLive(engineId: string): boolean {
  const { lease } = slot();
  if (!lease || lease.engineId !== engineId) return false;
  if (lease.expiresAt <= Date.now()) return false;
  return true;
}

export function currentPresenceSession(): { engineId: string; sessionId: string } | null {
  const { lease } = slot();
  if (!lease || lease.expiresAt <= Date.now()) return null;
  return { engineId: lease.engineId, sessionId: lease.sessionId };
}
