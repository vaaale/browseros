
## Key Observations for Refactoring

### What's Working Well

1. **Core OS types are framework-free** — `src/os/types.ts` has zero React/Next.js dependencies, making it portable.
2. **Apps are self-describing** — no central registry; discovery via filesystem pattern.
3. **Config system is pluggable** — adding a settings tab requires only a registration.
4. **API routes are thin delegates** — they don't contain business logic, they route to subsystems.
5. **VFS contract is narrow** — read/write/list/mkdir/remove/rename is a clean surface.

### Tension Points for Refactoring

1. **Agent system is a god layer** — it depends on almost everything (config, MCP, apps, memory, skills, workflows, specs, integrations) and almost everything depends on it (for tool exposure). This is the highest-risk subsystem for refactoring.

2. **No formal subsystem interfaces** — while folders provide some separation, there are no formal interface contracts between subsystems. Functions are called directly rather than through dependency injection or protocol abstractions.

3. **State management is monolithic** — `os-store.ts` handles windows, settings, and apps in a single store. A real OS would separate these concerns (window manager service, settings service, app service).

4. **Memory system is embedded in agent** — `src/lib/agent/memory/` is part of the agent folder but logically deserves its own subsystem (it could be used by non-agent contexts).

5. **Skills are embedded in agent** — same issue as memory. Skills could be a standalone subsystem used by both the agent and external consumers.

6. **Compaction is embedded in agent** — context compression could be a standalone utility used by any code path that builds prompts.

7. **VFS and GitFS are mixed** — `vfs.ts` contains both VFS operations and GitFS initialization logic, conflating two distinct storage concerns.

8. **No event/pub-sub layer** — subsystems communicate through direct function calls and shared Zustand store, making it hard to add new consumers without touching existing code.

9. **Integrations are tightly coupled to agent** — integration actions are registered as agent capabilities rather than being a standalone service that the agent *calls into*.

10. **Specs system has dual ownership** — code lives in `src/lib/specs/` and `src/lib/dev/spec-fs.ts`, while actual spec data lives in an external git repo under `BOS_SPECS_ROOT`. The boundary between "specs code" and "spec data" is unclear.

### Proposed Layering Principles

For the refactor, the user wants:
- **Lower layers = more stable interfaces**
- **Each subsystem provides interfaces for extension**
- **Clear dependency direction (no cycles)**

The natural layering emerging from the analysis maps well to a real OS metaphor:

| Layer | Subsystem | Analogy | Stability Target |
|-------|-----------|---------|-----------------|
| L0 | Core types & paths | Kernel ABI | Immutable |
| L1 | VFS + Storage | Filesystem | Very stable |
| L2 | State & Windows | Window manager | Stable |
| L3 | Config | System configuration | Stable |
| L4 | Apps | Application framework | Moderate |
| L5 | MCP + Integrations | Device/Service drivers | Moderate |
| L6 | Memory + Skills + Compaction | System services | Evolving |
| L7 | Agent runtime + Capabilities | Shell/DAEMON | Rapidly evolving |
| L8 | Workflows + Specs | User-space tools | Rapidly evolving |

