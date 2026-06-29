# Design heuristics & gotchas

Hard‑won rules baked into the code. Violating these is how BOS breaks subtly.

---

## Server vs. client

- Server‑only modules start with `import "server-only";` and may use Node
  (`fs`, `child_process`). They can only be imported by route handlers / server
  components.
- Client components start with `"use client";`.
- `src/os/types.ts` and the `workflows/types.ts`‑style "types" files are
  framework‑free **on purpose** — safe to import from both sides. Keep them that way.

## Hydration

`src/app/page.tsx` SSR‑seeds the store. The **first client render must match the
server markup** — don't introduce client‑only initial state. `desktop.spec.ts`
fails on hydration mismatch; treat it as a tripwire.

## The VFS is not the source tree

File tools + Files app see only `data/vfs`. BOS source is edited via the developer
agent's repo‑scoped tools, jailed to the repo (`src/lib/dev/repo-fs.ts`). Never look
for BOS code in the VFS.

## Atomic writes everywhere under `data/`

Use `writeFileAtomic` (temp + rename). It's the contract that makes the DataFS
**hardlink** isolation safe (a write creates a new inode; the shared canonical file
is never mutated). A non‑atomic write breaks preview isolation and crash‑safety.

## `data/` schema must be backward-compatible

The Supervisor shares one canonical `data/` across versions and **promote is
code‑only**; a (deferred) **rollback** would run older code on the same data. So any
storage change must be readable by the previous version. Migrate forward‑compatibly.

## Streaming events live outside React

Card‑collapse timers live in a **module‑level** store (`card-collapse.ts`), not in
components, because the chat remounts cards while streaming and would clear
per‑component timers. Sub‑agent/workflow progress streams as **NDJSON** so it
appears live, not batched at the end (`subagent-events.ts`, the run routes).

## Never resume an in-flight turn

`loadConversationMessages` trims to a settled tail (`trimToSettledTail`);
`saveConversationMessages` refuses to overwrite a non‑empty thread with an empty
snapshot. Guarded by `no-uncommanded-run.spec.ts`. Don't bypass these.

## Reasoning models need token headroom

Always pass the **configured** `maxTokens` to LLM calls — never a tiny hardcoded
cap. Reasoning models spend output tokens on hidden thought first; too small a cap
yields an empty reply. Surface `reasoning_content`/`<think>` as a "thinking" stream.

## Secrets stay server-side

Provider key lives in `data/provider.json`, **masked** in `/api/agent/provider` and
`/api/config`; OpenAI calls go through the in‑app proxy so the key never reaches the
browser. Mark new sensitive fields `secret: true`.

## Development is Claude-only

No coding with the local model. For a **non‑dev** task on a Claude agent, ask
permission first (`requestClaudeAgentPermission`). If the harness is unavailable,
say so — don't silently fall back.

## Graceful degradation

MCP servers, browser automation, and Playwright **degrade** when unavailable
(no tools rather than hard errors). Preserve this — gate features on capability
probes (`detectPlaywright`, MCP probes, `supervisorEnabled`).

## Prefer existing layers over new ones

Three storage layers exist for a reason (source / DataFS `data/` / GitFS `apps/`).
Pick the right one; don't invent a fourth path. Memory vs. skills is a real
distinction — *who/what* vs *how*. Don't add a third knowledge store.

## Keep mirrors in sync

`tool-manifest.ts` mirrors the registered actions (Tools panel). `specs/` mirrors
architecture. `docs/usage` + `docs/dev` (the source trees the in‑OS Docs app renders) mirror features for users and developers. Update all relevant mirrors
when you change behavior — and record intentional spec divergence in
`specs/discrepancies.md`.
