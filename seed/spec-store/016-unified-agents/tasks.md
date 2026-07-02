# Tasks: Unified Agent Model (016)

Phases are ordered; keep `tsc` green between phases. Build Studio is the only
seeded-scoped agent, so it's the canary throughout.

## Phase 1 — Capability registry
- [ ] T001 Add `src/lib/agent/capabilities-registry.ts` (framework-free): `Capability = { id, group, description, context: "action" | "tool" | "both" }` + `CAPABILITIES` list + helpers `actionIds()`, `toolIds()`, `capabilityById(id)`. Seed it from the current `tool-manifest.ts` action names and the `SUBAGENT_TOOLS`/`DEV_TOOLS`/`SPEC_TOOLS` keys.
- [ ] T002 Re-express `tool-manifest.ts` (`ASSISTANT_TOOLS`) as a view over the registry (actions), so the InfoPanel/Settings stay in sync with one source.

## Phase 2 — Dual-context gating (active chat)
- [ ] T003 Add `AgentCapabilitiesContext` + `useGatedCopilotAction(action)` (in `src/components/agent/agent-capabilities.tsx`): wrapper injects `available` from context; honors an explicit `available` if the action sets one; the back-compat rule (allow all unless the allowlist names ≥1 action id) lives here.
- [ ] T004 `CopilotProvider`: fetch the pinned agent's `tools` allowlist (via `/api/assistant/agent?agentId=`) and provide `AgentCapabilitiesContext`. Default to "all" until loaded.
- [ ] T005 Swap `useCopilotAction` → `useGatedCopilotAction` across the action components (OSActions, FilesActions if present, McpActions, SubAgentActions, MemoryActions, DevActions, ConfigActions, AssistantActions, SkillsActions, SelfImprovementActions, DocsActions, GitActions, WorkflowActions). Never gate the catch-all renderer.

## Phase 3 — Spec actions + Build Studio capabilities + back-compat
- [ ] T006 Add `src/components/agent/SpecActions.tsx` — client actions `listSpecs`/`readSpec`/`writeSpec`/`editSpec`/`searchSpecs` over `/api/specs`; mount in `CopilotProvider`; register in the registry (context "both").
- [ ] T007 Update the Build Studio agent seed (`subagents/store.ts` DEFAULTS) `tools` to the unified set it needs as active personality AND when delegated: spec actions + spec server tools + `delegateToSubAgent`/`delegate_to_developer` + `loadSkill` + `openSpecArtifact`/`refreshSpecTree` + `findTools`/`listMcpServerTools`/`callMcpServerTool` + `memory`/`recallMemories` + `listDocs`/`readDoc`.
- [ ] T008 Additive ensure on upgrade: for an existing on-disk `build-studio`, expand its `tools` to the new set (idempotent) so it doesn't lose actions; never clobber user edits to other agents.

## Phase 4 — Settings catalog + editor
- [ ] T009 `/api/assistant/agent` `buildCatalog()` → return the registry (id, group, description, context) instead of only sub-agent tool ids.
- [ ] T010 `AssistantTab` capability editor → render the unified, grouped, context-tagged list (one list governs both contexts); keep skills/MCP sections.

## Phase 5 — Verify
- [ ] T011 Tests: registry/`useGatedCopilotAction` allow-rule unit tests (pure); e2e that Settings → Assistant shows the unified catalog. tsc + lint + non-live e2e green.
- [ ] T012 Docs: update `docs/dev/assistant/*` (capability model) + `specs/discrepancies.md` if needed.

## Phase 6 — Naming cleanup (separable; ship after the functional core)
- [ ] T013 Rename the `SubAgent` type → `Agent` and internal fns (`getSubAgent`→`getAgent`, `listSubAgents`→`listAgents`, …); keep `src/lib/agent/subagents/` path and the LLM tool ids (`delegateToSubAgent`, `listSubAgents`, `createSubAgent`) as a compatibility surface; update UI labels/descriptions to read "agent". tsc-guarded.

## Dependencies
- Setup: T001 → T002.
- Gating: T003 → T004 → T005 (blocks the visible fix).
- T006 → T007 → T008 (BS must keep working once gating is on).
- T009 → T010. Then T011/T012. T013 last.
