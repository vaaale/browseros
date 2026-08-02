// The presence lease is what stops an engine's audio sink from swallowing replies
// after its surface is gone (036 FR-013). The bug it prevents was invisible: a
// closed avatar window left the plugin's socket open, so `isSinkActive()` kept
// answering yes, every utterance was routed to a face nobody could see, and the
// assistant went silent with no error at all.
//   npx playwright test -c playwright.unit.config.ts tests/services/presence-lease.test.ts
import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import {
  renewPresenceLease,
  releasePresenceLease,
  isPresenceLive,
  currentPresenceSession,
  PRESENCE_LEASE_TTL_MS,
} from "../../src/lib/voice/presence";
import {
  registerVoiceEngine,
  unregisterVoiceEngine,
  findActiveAudioSink,
} from "../../src/lib/voice/engine-registry";
import type { VoiceEnginePlugin } from "../../src/lib/bos-plugins/types";

const EMBODIED = "test-embodied-engine";
const SPEAKER = "test-speaker-engine";

function engine(id: string, opts: { surface?: boolean; sinkActive: boolean }): VoiceEnginePlugin {
  return {
    id,
    displayName: id,
    ...(opts.surface ? { surface: { url: `/api/plugin/${id}/surface` } } : {}),
    speak: async () => ({ durationMs: 0 }),
    interrupt: async () => {},
    isSinkActive: () => opts.sinkActive,
    playAudio: async () => {},
  };
}

function reset(): void {
  releasePresenceLease();
  unregisterVoiceEngine(EMBODIED);
  unregisterVoiceEngine(SPEAKER);
}

test.beforeEach(reset);
test.afterEach(reset);

test.describe("presence lease", () => {
  test("a renewed lease is live and names its session", () => {
    renewPresenceLease(EMBODIED, "session-1");
    expect(isPresenceLive(EMBODIED)).toBe(true);
    expect(currentPresenceSession()).toEqual({ engineId: EMBODIED, sessionId: "session-1" });
  });

  test("a lease belongs to one engine only", () => {
    renewPresenceLease(EMBODIED, "session-1");
    expect(isPresenceLive("some-other-engine")).toBe(false);
  });

  test("releasing drops it", () => {
    renewPresenceLease(EMBODIED, "session-1");
    releasePresenceLease(EMBODIED);
    expect(isPresenceLive(EMBODIED)).toBe(false);
    expect(currentPresenceSession()).toBeNull();
  });

  test("releasing a DIFFERENT engine leaves it alone", () => {
    renewPresenceLease(EMBODIED, "session-1");
    releasePresenceLease("some-other-engine");
    expect(isPresenceLive(EMBODIED)).toBe(true);
  });

  test("it expires on its own — nothing has to remember to release it", async () => {
    renewPresenceLease(EMBODIED, "session-1");
    expect(isPresenceLive(EMBODIED)).toBe(true);
    // The whole point: a surface that stops renewing (window closed, tab killed,
    // media never started) loses the lease with no cooperation from anyone.
    await new Promise((r) => setTimeout(r, PRESENCE_LEASE_TTL_MS + 50));
    expect(isPresenceLive(EMBODIED)).toBe(false);
  });
});

test.describe("findActiveAudioSink", () => {
  test("an engine WITH a surface is skipped while no lease is live", async () => {
    registerVoiceEngine(engine(EMBODIED, { surface: true, sinkActive: true }));
    // isSinkActive() says yes, but nothing is on screen — this is exactly the
    // state that used to lose the reply.
    expect(await findActiveAudioSink("omnivoice")).toBeUndefined();
  });

  test("the same engine is used once its surface holds a lease", async () => {
    registerVoiceEngine(engine(EMBODIED, { surface: true, sinkActive: true }));
    renewPresenceLease(EMBODIED, "session-1");
    expect((await findActiveAudioSink("omnivoice"))?.id).toBe(EMBODIED);
  });

  test("an engine with NO surface needs no lease — it has nothing to render", async () => {
    registerVoiceEngine(engine(SPEAKER, { sinkActive: true }));
    expect((await findActiveAudioSink("omnivoice"))?.id).toBe(SPEAKER);
  });

  test("a lease does not override the engine's own isSinkActive()", async () => {
    registerVoiceEngine(engine(EMBODIED, { surface: true, sinkActive: false }));
    renewPresenceLease(EMBODIED, "session-1");
    expect(await findActiveAudioSink("omnivoice")).toBeUndefined();
  });

  test("the configured engine is never its own sink", async () => {
    registerVoiceEngine(engine(EMBODIED, { surface: true, sinkActive: true }));
    renewPresenceLease(EMBODIED, "session-1");
    expect(await findActiveAudioSink(EMBODIED)).toBeUndefined();
  });
});
