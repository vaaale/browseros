# Scratchpad subsystem

Spec: `user-specs/scratchpad/spec.md` (external spec store). User‑facing:
`docs/usage/features/scratchpad.md`.

Conversation‑scoped, tool‑only note‑taking. Four CopilotKit actions —
`scratchpad_write`, `scratchpad_read`, `scratchpad_edit`, `scratchpad_delete` —
operate on a per‑conversation `Map<title, Note>`. There is no dedicated storage
layer: the conversation's own `messages[]` history is the source of truth, and
the Map is rebuilt from it lazily on first access.

---

## Files

- `src/lib/agent/scratchpad/types.ts` — `Note`, `NoteMetadata`, `ToolResult`,
  `ScratchpadOperation`, and the `ErrorCode` union. Framework‑free.
- `src/lib/agent/scratchpad/store.ts` — module‑level `Map<conversationId,
  Map<title, Note>>` plus getters/setters and an `initialized` set so replay
  runs exactly once per conversation. Exports `resetScratchpadForTests()`.
- `src/lib/agent/scratchpad/replay.ts` — `extractScratchpadOps` (walks a raw
  `messages[]` array and returns the scratchpad tool calls in order),
  `replayOperations` (applies them to the Map from a clean slate), and
  `ensureInitialized` (idempotent hydration that swallows loader errors).
- `src/lib/agent/scratchpad/handlers.ts` — pure `writeNote` / `readNotes` /
  `editNote` / `deleteNote`. Return `ToolResult` values; do no I/O.
- `src/components/agent/ScratchpadActions.tsx` — CopilotKit action wrappers.
  Reads the active conversationId via `useActiveConversationId(agentId)`,
  keeps it in a ref (mirrors `SubAgentActions`), and gates through
  `@/components/agent/gated-action` so 016‑unified‑agents allowlists apply.
- `src/lib/agent/capabilities-registry.ts` — four `scratchpad_*` entries in
  the `Scratchpad` group, `context: "action"` (client‑only; no server tool
  counterpart).
- `src/lib/agent/scratchpad/__tests__/` — hand‑run `runAll()` test suites
  (`handlers.test.ts`, `replay.test.ts`) matching the drive‑adapter pattern.

---

## Lifecycle

1. First scratchpad tool call for a `conversationId` triggers
   `ensureInitialized`.
2. `ensureInitialized` calls the injected `loadMessages` (points at
   `loadConversationMessages` in production; a test double in unit tests) to
   read `/Documents/Chats/<id>.json`, extracts scratchpad tool calls in
   chronological order, and replays them into the Map.
3. The `initialized` set is updated so subsequent calls skip re‑hydration.
4. Handler executes on the in‑memory Map and returns a `ToolResult`. The action
   wrapper JSON‑stringifies the result before returning it to CopilotKit.
5. The tool call itself is automatically appended to `agent.messages[]` by
   CopilotKit and persisted by `ChatPersistence`, so the next reload replays
   the exact same sequence.

Edits and deletes on notes that never existed are silently ignored during
replay — the same history could contain a `NOTE_NOT_FOUND` from a prior turn
and we must not diverge from what actually happened.

---

## Testing

No test runner is wired in; each test module exports `runAll()` and is
invoked ad‑hoc:

```bash
npx tsx -e "import('./src/lib/agent/scratchpad/__tests__/handlers.test.ts').then(m => m.runAll())"
npx tsx -e "import('./src/lib/agent/scratchpad/__tests__/replay.test.ts').then(m => m.runAll())"
```

The store exposes `resetScratchpadForTests()` so each test starts with an
empty Map and empty `initialized` set.

---

## Extension notes

- To add server‑side (sub‑agent) access, mirror the four capabilities as
  `context: "both"` and expose them via `toolsFor()`. State lives on the
  client today, so a server tool would need its own store or a proxy back to
  the client.
- To make notes cross‑conversation, replace the per‑conversation Map key with
  a stable id (user, agent, or "global") and hydrate from a durable file
  rather than the conversation history. This changes the trust model — the
  conversation history no longer fully determines state.
