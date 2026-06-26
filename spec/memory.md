# BrowserOS Memory System — Specification

BOS must have a **self-improving memory system** modeled on Hermes-Agent. This document specifies how it must work. It expands the one-line requirement in `bos.md` ("The agent must have a self-improving memory system similar to Hermes-Agent"). Design choices here are informed by a study of Hermes-Agent's implementation (`tools/memory_tool.py`, `agent/memory_provider.py`, `agent/background_review.py`, `agent/curator.py`, and the Skills subsystem). Its companion `spec/self-improvement.md` specifies the *learning loop* that decides what to write to memory and how skills evolve; this document specifies the memory substrate those writes land in.

The goal is an agent that **stops the user repeating themselves** and **gets better at recurring tasks over time**, without unbounded context growth and without hardening transient failures into permanent self-imposed constraints.

---

## 1. Conceptual model — three durable surfaces

Long-term knowledge MUST be split into three distinct surfaces, plus ephemeral context that is explicitly NOT memory.

1. **User profile** — *who the user is*: identity, role, durable preferences, communication style, expectations about how the assistant should behave, workflow habits. Declarative, slow-changing.
2. **Agent memory** — *the assistant's own notes*: environment facts, project conventions, tool quirks, durable lessons, and the current state of ongoing work. Declarative.
3. **Skills** — *how to do a class of task*: procedural knowledge captured from proven experience. Narrow, actionable, reusable. (Skills are specified in `bos.md`; this document covers how memory and skills co-evolve.)

**The split is load-bearing.** Memory answers "who the user is and what the current situation is"; skills answer "how to do this class of task for this user." A reusable procedure MUST become a skill, never a memory entry. A user preference about *how* a class of task should be done belongs in the relevant **skill body**, not only in memory.

**Not memory (ephemeral):** task progress, completed-work logs, temporary TODO state, raw data dumps, and one-off task narratives MUST NOT be written to durable memory. These belong to the conversation/session and may be served by search over past conversations, not by the memory store.

---

## 2. Storage & curation

- The User profile and Agent memory MUST each be **bounded and curated**, not an append-only log. Each surface has a configurable **size budget** (a character budget is preferred over a token budget because it is model-independent). Defaults SHOULD be small (on the order of a couple thousand characters for agent memory, less for the user profile) to force high-signal entries.
- Entries are short, declarative statements. The store keeps a list of entries; duplicates MUST be de-duplicated.
- **Consolidation over overflow.** When a write would exceed the budget, the system MUST NOT silently drop or truncate. It MUST reject the write and return the current entries plus an instruction to consolidate — merge overlapping entries, shorten, or remove stale ones — and allow the model to free space and add the new entry **in a single atomic operation** (see §4 batch writes).
- Storage SHOULD follow BOS's markdown-under-`data/` convention: the curated core lives in `data/memory/` (e.g. `USER.md` and `MEMORY.md`), consistent with how agents (`data/agents`) and skills (`data/skills`) are stored. A larger, queryable/secondary tier MAY exist (see §3, §9).
- Writes MUST be durable and crash-safe: atomic file replacement (temp file + rename) and read-modify-write locking so concurrent writers (multiple windows, sub-agents, background review) do not corrupt or clobber the store.

---

## 3. Injection & recall

The curated core (User profile + Agent memory) is small, so it MUST be made available to the assistant by **always-on injection**, not by retrieval search.

- **Frozen-snapshot injection.** At the start of a chat session the curated memory is captured as a snapshot and injected into the composed system instructions (alongside the core policy, the active agent's personality, and the skills index — see `composeInstructions`). The snapshot is **frozen for the duration of the session**: mid-session writes persist to disk immediately (durable) but do NOT change the in-session system prompt.
  - **Why:** a stable system prompt preserves the model's prefix cache across turns. Rebuilding the prompt on every write would invalidate the cache and inflate cost/latency. The snapshot refreshes on the next session start, so new memories take effect in the next conversation.
- The injected blocks MUST be clearly labeled (e.g. "USER PROFILE — who the user is" and "MEMORY — your notes") with a usage indicator (current/limit).
- The curated core MUST remain authoritative across context compression: if the conversation is compacted, persistent memory is unaffected and stays in the system prompt.
- **Queryable / semantic recall (optional tier).** For knowledge that is too large to always inject, BOS MAY provide a queryable memory store with a recall tool (a `recallMemories`-style query returning the most relevant entries, ranked by keyword/semantic match, recency, and usefulness). This tier MAY be backed by the built-in store or by an external provider (§9). It is complementary to — not a replacement for — the always-injected curated core.

---

## 4. The memory tool

The assistant (and the background-review pass, §6) writes memory through a single tool.

- **One `memory` tool**, with `target` ∈ {`user`, `memory`} and `action` ∈ {`add`, `replace`, `remove`}.
- `replace` and `remove` MUST identify the target entry by a **short unique substring** (not an opaque id and not the full text). If the substring matches multiple distinct entries, the tool MUST refuse and ask for a more specific substring.
- A **batch shape** MUST be supported: a list of operations applied **atomically against the final budget** in one call, so the model can remove/shorten stale entries and add new ones together even when the add alone would overflow. The batch is all-or-nothing.
- Success responses MUST be **terminal**: confirm the write landed and signal completion; do NOT echo the full entry list on success (it invites the model to thrash and re-issue writes). Entries are returned only on the error/over-budget path, where the model needs them to decide what to consolidate.

**Guidance the tool MUST convey to the model (what to save / skip):**
- SAVE proactively when the user states a preference, a correction, or a personal detail, or when a stable fact about the environment/conventions/workflow is learned. Priority order: **user preferences & corrections > environment facts > procedures**. The best memory stops the user repeating themselves.
- TARGETS: `user` = identity/role/preferences/style; `memory` = environment, conventions, tool quirks, lessons, current operational state.
- SKIP: trivial or obvious info, easily re-discoverable facts, raw data dumps, task progress, completed-work logs, temporary TODO state. **Reusable procedures belong in a skill, not memory.**

---

## 5. Skills as procedural memory

Skills are the procedural surface of memory and co-evolve with it (full skill structure is specified in `bos.md`). For the memory system, the following MUST hold:

- A skill is a directory: a `SKILL.md` (frontmatter: name, a one-sentence description, when-to-use; body) plus optional `references/` (session-specific detail and condensed knowledge banks), `scripts/` (re-runnable helpers), and `templates/` (starter files to copy).
- Skills carry **provenance**: `agent`-created vs seeded/built-in. This drives the skill lifecycle (specified in `spec/self-improvement.md` §5).
- The library SHOULD trend toward **class-level "umbrella" skills** — a rich SKILL.md with a `references/` directory for specifics — NOT a long flat list of one-session, one-skill entries. A skill name MUST be at the class level (e.g. "Debugging the proxy") and MUST NOT be a session artifact (a specific bug id, error string, codename, or "fix-X-today").

---

## 6. Self-improvement loop (writes to memory)

Memory is kept current by the **self-improvement loop** — a post-task review pass that decides what to save or update. That loop, the skill signals it acts on, its anti-patterns, and GEPA skill optimization are specified in full in `spec/self-improvement.md`. This section states only its contract with the memory substrate:

- The review runs as a **separate, restricted pass** (memory + skill-management tools only) and writes memory through the memory tool (§4); it MUST NOT mutate the live conversation or its prompt cache.
- It writes to the **user profile** when the user reveals identity, durable preferences, or expectations, and to **agent memory** when a durable environment fact, convention, or lesson emerges.
- It MUST NOT record transient or environment-specific failures, negative tool claims, resolved transient errors, or one-off task narratives as durable memory — these become self-imposed constraints. Reusable procedures belong in a **skill**, not memory.

---

## 7. Skills & their lifecycle

Skills are the procedural surface that co-evolves with memory. Their creation and editing, optimization over time (GEPA), and lifecycle maintenance — the **Curator** (usage telemetry, staleness transitions, archive-but-never-delete, pinning, agent-only provenance) — are specified in `spec/self-improvement.md` (§3–§5) and `bos.md`. The memory↔skill split MUST be preserved: *who the user is and the current state* → memory; *how to do a class of task* → a skill.

---

## 8. Safety & integrity

Because memory is injected into the system prompt and persists across sessions, it is an attack surface and an integrity risk.

- **Injection/exfiltration scanning.** Memory content MUST be scanned for prompt-injection / promptware / exfiltration patterns both at **write time** and at **snapshot-build (load) time**. A poisoned on-disk entry MUST be replaced with a clearly marked placeholder in the injected snapshot (so it cannot influence the model) while remaining visible in the raw store so the user can review and delete it. Silent dropping is NOT acceptable — it would hide the attack.
- **External-drift detection.** If the on-disk store contains content that would not round-trip through the memory tool (a manual edit, a different tool, or a concurrent writer appended free-form text), the tool MUST refuse to overwrite, back up the current file, and ask the operator to reconcile — preventing silent data loss.
- **Write approval (optional gate).** BOS MAY gate memory writes behind approval. In autonomous/background contexts a write can be **staged** for later user approval; in interactive contexts it MAY prompt (e.g. an elicitation card). The gate is off by default for the interactive assistant.
- **Sub-agent restrictions.** Leaf sub-agents MUST NOT write to the shared memory store. Instead, the delegating (parent) assistant observes the delegation result and decides what, if anything, to remember. (This prevents worker sub-agents from polluting the user's representation.)

---

## 9. Pluggable memory providers (extensibility)

BOS SHOULD treat memory as a **pluggable capability** with a built-in default, mirroring Hermes' provider architecture:

- A **built-in provider** (the file-backed curated core in §2–§4) ships and is active by default.
- BOS MAY support **one external provider at a time** (e.g. a semantic/vector backend) to avoid tool-schema bloat and conflicting backends. The active provider is selected in configuration.
- A provider exposes a small lifecycle surface: initialize; contribute a static system-prompt block; `prefetch(query)` (background recall before a turn); `sync_turn(user, assistant)` (write after a turn); expose its own tool schemas; and shut down cleanly.
- Optional hooks a provider MAY implement: end-of-session extraction; **pre-compression extraction** (capture insights from messages about to be discarded by context compression); and observe delegation outcomes on the parent.

This section is forward-looking: the built-in provider is mandatory; external providers are optional.

---

## 10. Lifecycle interplay

- **Context/conversation compression.** Before old turns are compacted/discarded, the system SHOULD extract any durable insight worth keeping. Persistent memory remains authoritative regardless of compaction.
- **Sessions/conversations.** Memory is scoped to the user/profile, not to a single conversation; it persists across conversations and reloads. New memories written during a session take effect at the next session's snapshot.
- **Background/automated runs.** Automated runs (e.g. scheduled jobs) SHOULD NOT write to the user profile by default — their system prompts and machine-driven context would corrupt the representation of the human user.

---

## 11. UI & configuration

- The **Memory app** MUST let the user view, edit, and remove entries in both the User profile and Agent memory, and review what the assistant has learned.
- **Skills** are managed in Settings → Skills (per `bos.md`).
- Configuration MUST expose at least: memory size budgets; whether the self-improvement review runs (and which model it uses); the write-approval gate; the active memory provider; and Curator settings. Per the BOS configuration system, exposing these as a config namespace also exposes them to the assistant as tools.

