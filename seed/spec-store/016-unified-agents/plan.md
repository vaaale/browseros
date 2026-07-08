# Implementation Plan: Unified Agent Model (016)

**Branch**: `016-unified-agents` | **Date**: 2026-06-29 | **Spec**: [spec.md](./spec.md)

## Summary

Make "agent" the only concept and let one capability allowlist govern an agent in
**both** execution contexts. The split today: server-side `toolsFor(agent.tools)`
gates delegated runs (`runLocal`), while the active chat mounts every CopilotKit
action in `CopilotProvider` with no gating. We add a **capability registry** (shared
ids + the context each runs in), gate the active chat's actions via CopilotKit's
`available` flag keyed to the pinned agent, keep `toolsFor()` for delegated runs off
the same list, and add client-side **spec actions** so Build Studio works as the
active personality. Naming cleanup (drop the `SubAgent` *type*) is the last, separable
phase.

## Technical Context

- One pool already: `data/agents/<id>/AGENT.md` (frontmatter `tools/skills/mcp` +
  body personality). `unset/empty allowlist = all` (`capabilities.ts` `isAllowed`).
- Active chat: `CopilotProvider` → `<OSActions/> … <WorkflowActions/>` each calling
  `useCopilotAction`. Delegated: `runner.ts` → `toolsFor(agent.tools)`.
- Catalog for Settings: `/api/assistant/agent` `buildCatalog()` (today only
  sub-agent tool ids). Editor: `AssistantTab`.
- CopilotKit supports `available: "enabled" | "disabled"` per action (confirmed).

## Design

### Capability registry (`src/lib/agent/capabilities-registry.ts`, framework-free)
A single list of `{ id, group, description, context: "action" | "tool" | "both" }`.
- `action` = a main-chat CopilotKit action (id = the `useCopilotAction` name).
- `tool` = a server sub-agent tool (id = the `toolsFor` key).
Generated/asserted against `tool-manifest.ts` (actions) + `SUBAGENT_TOOLS`/`DEV_TOOLS`/
`SPEC_TOOLS` keys (tools). New **spec actions** are registered in both.

### Dual-context gating
- **Active chat**: a small `useGatedCopilotAction(action)` wrapper reads an
  `AgentCapabilitiesContext` (the pinned agent's allowed-action set) and injects
  `available`. `*Actions` swap `useCopilotAction` → `useGatedCopilotAction` (mechanical).
  `CopilotProvider` fetches the pinned agent's `tools` allowlist and provides the
  context. The catch-all renderer is never gated.
- **Delegated**: unchanged `toolsFor(agent.tools)`.

### Back-compat rule (critical)
Gating client actions by `tools` would disable ALL actions for any agent whose
allowlist lists only *server* ids (the legacy state). Rule: **client actions are
gated only if the allowlist names at least one action id; otherwise all actions are
allowed** (so legacy/`unset` agents keep working). Build Studio's seed + an additive
ensure are updated to include the action ids it needs.

### Spec actions (`src/components/agent/SpecActions.tsx`, new)
Client actions `listSpecs`/`readSpec`/`writeSpec`/`editSpec`/`searchSpecs` calling the
existing `/api/specs` route, so an active-personality agent (Build Studio) authors
specs without forced delegation. Registered in the registry + BS allowlist.

### Settings
`buildCatalog()` returns the registry (grouped, context-tagged); `AssistantTab` shows
one capability list per agent.

### Phasing
1. Registry. 2. Gating (wrapper + context + provider + swap call sites). 3. SpecActions
+ BS allowlist seed/ensure + back-compat rule. 4. Settings catalog/editor. 5. Tests +
tsc/lint/e2e. 6. (separable) Naming: `SubAgent`→`Agent` symbols (keep dir path + LLM
tool ids as a compat surface; labels/descriptions say "agent").

## Risks
- Mass `useCopilotAction` swap — mechanical; tsc-guarded.
- Back-compat: only `build-studio` is seeded-scoped, so blast radius is small; the
  "names an action id?" rule protects any user-scoped agents.
- Phase 6 rename is high-churn/low-value — done last, can ship after the functional core.
