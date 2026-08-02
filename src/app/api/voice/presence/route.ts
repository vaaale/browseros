import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getVoiceEngine } from "@/lib/voice/engine-registry";
import {
  renewPresenceLease,
  releasePresenceLease,
  currentPresenceSession,
  PRESENCE_LEASE_TTL_MS,
} from "@/lib/voice/presence";
import "@/lib/voice/tts"; // side-effect: ensures built-in engines are registered

export const dynamic = "force-dynamic";

// Lifecycle of the agent's visible presence (036). Driven by BOS's presence
// window — never by the surface itself, so a surface cannot claim to be live
// while nothing is mounted.
//
//  open    → the window mounted: start the engine session, hand back its id
//  playing → the surface reports media is rendering: renew the lease
//  stopped → media paused/ended: drop the lease, audio returns to the browser
//  closed  → the window went away: end the engine session (closing whatever
//            connection it holds) and drop the lease
export async function POST(req: NextRequest) {
  try {
    const { engineId, state, sessionId } = await req.json() as {
      engineId?: string;
      state?: "open" | "playing" | "stopped" | "closed";
      sessionId?: string;
    };
    if (!engineId || !state) {
      return NextResponse.json({ error: "engineId and state are required" }, { status: 400 });
    }
    const engine = getVoiceEngine(engineId);
    if (!engine) return NextResponse.json({ error: `Unknown voice engine: ${engineId}` }, { status: 404 });

    switch (state) {
      case "open": {
        const id = sessionId || randomUUID();
        await engine.onSessionStart?.(id);
        return NextResponse.json({ sessionId: id, leaseTtlMs: PRESENCE_LEASE_TTL_MS });
      }
      case "playing": {
        const id = sessionId || currentPresenceSession()?.sessionId || "";
        renewPresenceLease(engineId, id);
        return NextResponse.json({ ok: true, leaseTtlMs: PRESENCE_LEASE_TTL_MS });
      }
      case "stopped": {
        releasePresenceLease(engineId);
        return NextResponse.json({ ok: true });
      }
      case "closed": {
        releasePresenceLease(engineId);
        const id = sessionId || currentPresenceSession()?.sessionId || "";
        await engine.onSessionEnd?.(id);
        return NextResponse.json({ ok: true });
      }
    }
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
