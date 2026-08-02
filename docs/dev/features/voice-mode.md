# Voice mode

Specs: `bos-system-specs/033-pluggable-voice-engines/spec.md` §9a (engines, the
single-producer rule) and `036-embodied-presence/spec.md` (the output model and the
agent's face), both in the external spec store.

Voice has two halves, switched on from the Assistant input row:

- **Input** — the microphone button. Activation mode (push‑to‑talk, wake word,
  key‑to‑talk) is configuration and lives in Settings → Voice.
- **Output** — the speaker and video buttons beside it.

Output is **one setting with three values**, `VoiceConfig.voiceOutput`:

| value | meaning |
| --- | --- |
| `off` | replies are text only; nothing is synthesized |
| `audio` | replies are spoken |
| `avatar` | replies are spoken by an embodied engine in the presence window |

The speaker button maps `off → audio` and anything else `→ off`. The video button
maps `≠ avatar → avatar` and `avatar → audio`. It is deliberately not two
booleans: "video means audio and video" is an invariant, and two flags can always
be made to contradict it. There is no representable state with a face on screen and
the sound off.

`voiceOutput !== "off"` is the **only** gate on speech. Earlier models had a
separate "enable voice mode" checkbox and then a `speakReplies` boolean; both are
migrated on load and disappear from `voice-config.json` on the next save. Settings
owns *how* voice works; the Assistant owns *whether it is on right now*.

---

## Files

- `src/hooks/useVoice.ts` — the whole client side: mic capture and VAD (Silero,
  with an energy‑RMS fallback), STT, auto‑submit, barge‑in, **and TTS**.
- `src/lib/voice/client/config-store.ts` — the ONE client-side copy of the voice
  config, shared by the mic button, Settings and the presence host. Every consumer
  used to fetch `/api/voice` for itself; two such copies disagreeing is what let
  TTS run with the setting off.
- `src/lib/voice/client/status-store.ts` — is the agent speaking right now.
  Published by `useVoice`, consumed by the presence window (which lives in another
  window entirely, so a prop won't reach it).
- `src/components/voice/VoiceMicButton.tsx` — mic button, speaker and video
  toggles, waveform, activation popover. Mounted once per chat by `ChatInputV2`.
- `src/components/voice/PresenceHost.tsx` — turns `voiceOutput === "avatar"` into a
  window. Mounted on the **desktop**, not in the Assistant.
- `src/apps/presence/` — the hidden, singleton window that hosts an engine's
  surface.
- `src/lib/voice/presence.ts` + `src/app/api/voice/presence/route.ts` — the
  presence lease and the engine-session lifecycle.
- `src/components/voice/VoiceActivationPopover.tsx` — activation mode / wake word /
  threshold, without duplicating the speaker toggle next to it.
- `src/components/apps/settings/VoiceTab.tsx` — engine, STT, VAD, activation
  configuration. Debounced saves **accumulate** pending patches; replacing them
  drops fields silently.
- `src/lib/voice/config.ts` — load/save plus the migration of the legacy
  `enabled`/`speakReplies` booleans. `voiceOutput` defaults to `"off"`: BOS never
  speaks unless asked.
- `src/lib/voice/voice-hook.ts` — the system‑prompt addition telling the agent its
  replies are spoken, emitted only when `voiceOutput !== "off"`.
- `src/lib/voice/engine-registry.ts`, `src/lib/voice/tts/` — pluggable engines and
  the audio‑sink handoff (see spec 033).
- `e2e/voice-tts-toggle.spec.ts` — stubs `/api/voice/tts` and counts calls, so
  "silent when off" and "exactly once when on" are enforced.

---

## `useVoice` is the only TTS producer

Every activation mode, and typed messages too, speak through the one effect in
`useVoice`. **Do not add a second producer.** There used to be one — a passive
`VoiceTTSPlayer` mounted by `AssistantChatV2` — and because each producer cached
its own copy of the voice config and applied its own gate, replies were spoken
after the user turned speech off and synthesized twice when both agreed it was on.

The spoken cursor is keyed by **assistant message id**, held in a
`Map<messageId, charsSpoken>`:

1. **Streaming** — complete sentences past the cursor are queued as they arrive, so
   speech starts before the reply is finished.
2. **Finalized message** — whatever the stream did not cover is spoken then.

Step 2 is not a fallback for rare cases; it is the only path that fires for short
replies. The store clears `streamText` when a message finalizes, and a reply that
arrives in a single delta is batched with its own finalize event, so the streamed
text never appears in a render. A cursor over a snapshot of `streamText` speaks
nothing at all in that case.

Two further invariants:

- The cursor advances **even while muted**, so switching the speaker on mid‑reply
  resumes at the next sentence rather than restarting the answer.
- Only text arriving while a run is live (or in the render batch that ends it) is
  spoken. Opening a conversation or switching transcripts records the existing
  messages as already‑spoken — history is never read aloud.

Segments are queued through a promise chain with a generation counter; a barge‑in
bumps the generation so queued‑but‑unstarted segments are dropped, aborts the
in‑flight request, and calls `/api/voice/interrupt` so a plugin engine stops too.

---

## The agent's face

A voice engine may declare a **surface** — a URL BOS hosts in the presence window:

```ts
surface?: { url: string; label?: string }
```

That is the whole extension point. BOS knows nothing about avatars, WebRTC or
AVTR‑1; `live-avatar` is a plugin whose surface page holds the peer connection and
receives audio + video straight from its server. The presence provider is chosen
independently of `ttsProvider`, because an embodied engine works as an **audio
sink**: it renders whatever another engine synthesized (see 033 §7), so you can
keep OmniVoice as the voice and still have a face.

Lifecycle — BOS drives it, the surface only reports:

| direction | message | meaning |
| --- | --- | --- |
| surface → BOS | `bos-surface-ready` | loaded |
| BOS → surface | `bos-surface-connect` | start now (there is no Connect button) |
| surface → BOS | `bos-surface-aspect` `{ratio}` | intrinsic video shape → window geometry |
| surface → BOS | `bos-surface-playing` / `-stopped` | media really is rendering |
| surface → BOS | `bos-surface-error` `{message}` | give up; BOS shows it and offers audio‑only |
| BOS → surface | `bos-surface-speaking` `{speaking}` | the agent started/stopped talking |

The window is sized from the reported ratio: height is 25% of the viewport, width
follows the aspect, positioned in the upper‑left quadrant offset from the corner.
Until the first frame arrives BOS uses a square guess, then snaps.

### The presence lease — why a socket is not evidence

An engine's audio sink **swallows** every utterance: the TTS route hands it the
audio and withholds the data URL so the browser doesn't speak it twice. That is
only correct while the sink is genuinely rendering.

It used to be gated on `isSinkActive()` alone, which for `live-avatar` meant "my
WebSocket is open". Closing the avatar's window didn't close that socket, so every
reply went to a face nobody could see — **a silent assistant with no error**.

So liveness is a lease (`src/lib/voice/presence.ts`) that the presence window
renews while its surface reports it is playing, and which expires on its own.
`findActiveAudioSink()` requires both `isSinkActive()` and a live lease for any
engine that has a surface. If the window closes, the media never starts, or the tab
dies, nothing renews it and audio comes back to the browser with no user action.

"Remember to disconnect" is not a fix for this class of bug: liveness has to be
something the renderer keeps proving.

### Session ownership

The engine session belongs to the presence window, not the microphone
(033 §8, amended). `POST /api/voice/presence` with `state: "open"` starts it and
`"closed"` ends it — which is what makes an engine drop its connection. Driving it
from the mic was wrong both ways: deactivating the mic tore down a live avatar, and
closing the avatar left its socket up. The browser no longer holds a session id at
all; the server resolves it from the lease.
