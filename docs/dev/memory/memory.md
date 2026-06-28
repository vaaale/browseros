# Memory subsystem

Spec: `specs/002-memory/spec.md`. User‑facing: `docs/usage/memory/how-memory-works.md`.

Two durable, curated surfaces, **injected** into the assistant's instructions as a
**frozen snapshot** at conversation start.

---

## Storage (`src/lib/agent/memory/curated.ts`, server‑only)

- `data/memory/USER.md` — the **user profile** (who you are). Budget **1200** chars.
- `data/memory/MEMORY.md` — **agent memory** (the assistant's notes). Budget **2000**
  chars.

Each file is a list of short bullet entries. Helpers: `readUser()`, `readMemory()`,
`memorySnapshot()` (builds the injected blocks), `addEntry(target, content)`,
`replaceEntry`, `removeEntry`, and a batch `applyMemoryOps(ops)`.

- **Atomic writes** via temp‑file + rename.
- **Budget enforcement:** an add/replace that would exceed the budget is **rejected**
  (not truncated); the error tells the agent to **consolidate** first. `apply
  MemoryOps` lets it remove/replace several entries and add the new one in one atomic
  batch.
- **Injection‑safety:** new entries are scanned for prompt‑injection patterns
  (`looksLikeInjection`) and refused — because this text becomes part of the
  system prompt.

---

## The memory tool (`src/lib/agent/memory/tool.ts`)

`MEMORY_LLM_TOOL` is an `LlmTool` (for the review/server loops) exposing the same
ops (`add`/`replace`/`remove`, batched). The client‑facing equivalent is the
`memory` action (`MemoryActions.tsx`) → `/api/memory`. `recallMemories` reads the
**live** entries (vs. the frozen snapshot in the prompt).

---

## Injection into instructions

`composeInstructions()` ([Assistant overview](../assistant/overview.md)) embeds
`memorySnapshot()` after the active agent's personality. The snapshot is captured
**once per conversation**, so:

- mid‑session writes persist to disk immediately, but
- they only influence behavior from the **next** conversation (stable within a chat).

---

## Memory vs. skills (don't mix)

- **Memory** = *who you are* + *current situation* (durable, always‑on, bounded).
- **Skills** = *how to do a class of task* (on‑demand procedures). See
  [Self‑improvement](../self-improvement/self-improvement.md).

The [review pass](../self-improvement/self-improvement.md) routes durable
preferences/details → memory and reusable procedure/style lessons → skills, and is
explicitly told **not** to harden transient/environment‑specific failures into
memory.

---

## API (`/api/memory`)

- **GET** → `{ user: string[], memory: string[] }`.
- **POST** `{ target:"user"|"memory", action:"add"|"replace"|"remove", content, … }`.
- **DELETE** `?target=&text=`.

The Memory app (`src/apps/memory/index.tsx`) is a thin UI over this.
