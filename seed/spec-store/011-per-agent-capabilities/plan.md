# Implementation Plan: Per-Agent Capabilities (Tools, Skills, MCP)

**Branch**: `011-per-agent-capabilities` | **Date**: 2026-06-28 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/011-per-agent-capabilities/spec.md`

## Summary

Give each agent an optional allowlist of **tools, skills, and MCP servers** (unset = all,
so nothing regresses). Enforce it at every point a capability is exposed: the main chat's
actions (conditional registration), the composed skills index (filtered), and the MCP tools
wired into the runtime (filtered). Manage it from **Settings → Assistant**. Tools are already
per-agent for sub-agents; this adds skills + MCP + the UI + main-chat enforcement.

## Technical Context

**Language/Version**: TypeScript — Next.js (App Router), React.

**Primary Dependencies**: existing — CopilotKit, the sub-agents store, the config system. No new deps.

**Storage**: capability allowlists in each agent's `AGENT.md` frontmatter (`data/agents/<id>/AGENT.md`).

**Testing**: a unit test for capability resolution + a Playwright e2e for the Settings scoping flow.

**Target Platform**: BOS (SSR web app).

**Project Type**: Web — single Next.js project.

**Constraints**: server/client boundary (capability data is server-side; the client fetches the active agent's tool allowlist via an API to gate actions); unset/empty allowlist = full access.

**Scale/Scope**: a handful of agents × three capability classes.

## Constitution Check

*GATE: must pass before design; re-check after.*

- **I. Spec-Driven**: derived from `spec.md`. PASS.
- **II. Server boundary**: capability data + skills/MCP filtering are server-side (`capabilities.ts`, `instructions.ts`, `runtime.ts`); the client fetches the active agent's tool allowlist via `/api/assistant/agent`. PASS.
- **III. Delegate / Claude codes**: this is a config/capability feature, built by the Developer. PASS.
- **IV. Minimize blast radius**: built on a feature branch under the supervisor. PASS.
- **V. VFS ≠ source**: N/A. PASS.
- **VI. Specs & docs sync**: updates `docs/usage/assistant` + `docs/dev/assistant`. PASS.
- **VII. Respect boundaries**: no secrets/lockfiles/build config touched. PASS.

No violations → Complexity Tracking holds only the action-gating note below.

## Project Structure

### Documentation (this feature)

```text
specs/011-per-agent-capabilities/
├── spec.md   # done (clarified)
├── plan.md   # this file
└── tasks.md  # next
```

### Source Code (BOS repository)

```text
src/lib/agent/
├── capabilities.ts            # NEW — resolve an agent's effective {tools, skills, mcp} (unset/empty = all); single source of truth
├── instructions.ts            # EDIT — composeInstructions(agentId?) filters the skills index by the agent's allowed skills
├── runtime.ts                 # EDIT — buildRuntimeOptions filters MCP servers by the active agent's allowed set
└── subagents/
    ├── types.ts               # EDIT — add skills?/mcp? to SubAgent
    └── store.ts               # EDIT — read/write skills+mcp frontmatter; additive default scopes for built-in agents

src/app/api/assistant/agent/route.ts   # EDIT — expose/update per-agent allowlists + a catalog of available tools/skills/mcp for the UI

src/components/agent/
├── AgentCapabilities.tsx      # NEW — client context/hook: the active agent's allowed action ids (gates registration)
├── useGatedAction.ts          # NEW — wrapper over useCopilotAction that registers only when allowed
└── *Actions.tsx               # EDIT — register each action through the gate

src/components/apps/
├── settings/AssistantTab.tsx  # EDIT — per-agent tools/skills/mcp editors (grouped multi-selects)
└── assistant/InfoPanel.tsx    # EDIT — reflect the active agent's scoped set
```

**Structure Decision**: a single server-side resolver (`capabilities.ts`) is the source of truth for an agent's effective capabilities; the client mirrors only the active agent's *tool* allowlist (for action gating). Skills and MCP are filtered entirely server-side.

## Design notes

### Data model
`SubAgent` gains `skills?: string[]` and `mcp?: string[]` (alongside the existing `tools?: string[]`). Persisted as `AGENT.md` frontmatter lists. For any class, **unset or empty = all** (back-compatible). `capabilities.ts` resolves the effective set for an agent against the live catalogs (all tools / all skills / all MCP servers).

### Tools — main chat (conditional registration)
The CopilotKit actions are registered globally and are otherwise available to every agent. A client **AgentCapabilities** context exposes the active agent's allowed action ids; a `useGatedAction` wrapper registers an action only when allowed. No reliance on a CopilotKit `available` flag (not found in the installed types) — conditional registration is the mechanism. *(Verify during build: if this CopilotKit version does expose `available`, prefer it as a simpler equivalent.)*

### Tools — sub-agents
`toolsFor(agent.tools)` already gates sub-agent runs; unchanged.

### Skills
`composeInstructions` gains an optional `agentId`; it filters `listSkills()` by that agent's allowed skill ids before building the index (defaulting to the active agent). The optional param also serves `012` (agent-scoped embeds).

### MCP
`buildRuntimeOptions` resolves the active agent (`getActiveAgentId`) and includes only its allowed MCP servers. It is already built per-request, so Settings changes apply live. (`012` will thread an embed's agent through so embeds scope MCP too.)

### UI (Settings → Assistant)
`AssistantTab` gains, per selected agent, three grouped multi-selects (tools / skills / MCP) populated from the catalog the API returns; saving patches the agent's `AGENT.md`. The Assistant's `InfoPanel` reflects the active agent's effective set.

### Capability id space
Gateable capabilities are referenced by stable ids: tool/action `name`s (CopilotKit actions + sub-agent tool ids), skill ids, and MCP endpoints/names. The UI groups them by category.

## Complexity Tracking

| Violation | Why needed | Simpler alternative rejected because |
|-----------|------------|--------------------------------------|
| Gating touches many `*Actions` components | The spec requires the **active personality** (not only sub-agents) to honor its tool scope, and the actions are registered globally | Gating only sub-agents (already supported) would not satisfy FR-002/FR-006; the `useGatedAction` wrapper keeps the change uniform and small per file |

## Out of scope

`012`/`013` (the embed + Build Studio consumption); per-conversation capability overrides; capability *bundles* (capabilities are individual ids, grouped only in the UI).
