import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { listCapabilities } from "@/lib/agent/capabilities-registry";
import { buildIndex, search } from "@/lib/agent/discovery-search";
import { resolveGroup } from "@/lib/agent/tool-groups";
import { getEffectiveGroups } from "@/lib/agent/tool-group-overrides";
import { scoreAgent } from "@/lib/agent/discovery-score";
import { listDelegatableAgents } from "@/lib/agent/subagents/store";
import { getMaxFindResults } from "@/lib/config/registry";
import { gateFor, gateFromAgent } from "../../gate";
import { getInRunAgent } from "@/lib/agent/subagents/in-run-agents";
import { runManager } from "../../run-manager";

// Runtime tool/agent discovery (025 + 041-tool-groups). ALWAYS-available (never
// registry-gated).
//
// find_tools returns an ENVELOPE `{ results, totalMatches, withheld, ... }`.
// The v2 loop derives the "revealed" deferred set from `results[].id` in the
// transcript (src/lib/assistant/messages.ts + src/lib/agent/tool-gate.ts, both
// of which also still accept the legacy bare-array shape from older
// conversations), so a discovered tool becomes callable on the next step with
// no explicit reveal callback.
//
// RESULTS DELIBERATELY CARRY NO JSON SCHEMA (041 FR-024a / ADR-7). Revealing a
// tool already un-gates it into the provider's NATIVE tool field on the next
// step, where the model receives its real schema from the provider. Copying the
// schema into the tool result duplicated data nothing reads back, and it was
// the only thing making an uncapped group mode expensive. Descriptions ARE
// returned: the model has to judge relevance at find time, before the native
// declaration exists.

interface FindToolsResult {
  id: string;
  group: string;
  description: string;
  /** Why this matched — field + term, so relevance is inspectable (FR-023). */
  reasons: { term: string; field: string }[];
}

export function discoveryTools(lookup: (id: string) => AssistantTool | undefined): Record<string, AssistantTool> {
  return {
    find_tools: serverTool(
      "find_tools",
      "Discover tools that are available to you but not currently visible. Search by natural-language description of what you need (`query`), or ask for a whole group by name (`group`) — the groups you have are listed in your system prompt, along with how many tools each is hiding. Returns id, description and why each matched; a returned tool becomes callable on your NEXT step, with its full parameter schema delivered normally. Does NOT find MCP tools — use mcp_tool_search for those.",
      schema(
        {
          query: p.str("Natural-language description of the capability you need (min 2 characters). Optional if `group` is given."),
          group: p.str("Name or id of a tool group to list in full, e.g. \"web\" or \"Google Calendar\". Optional if `query` is given."),
        },
        [],
      ),
      async (input, ctx) => {
        const query = String(input.query ?? "").trim();
        const groupQuery = String(input.group ?? "").trim();
        if (!query && !groupQuery) {
          return JSON.stringify({ results: [], totalMatches: 0, withheld: 0, message: "Provide `query`, `group`, or both." });
        }

        // ADR-12 (Workflow Manager service-tools): an EPHEMERAL agent is not
        // persisted, so gateFor(ctx.agentId) resolves to an empty gate. When
        // this run registered an in-memory agent (runLocalHeadless), resolve
        // the gate from THAT object so find_tools returns its declared deferred
        // tools (FR-034 of 025). A named agent's runId is never registered, so
        // its gate still resolves via gateFor(ctx.agentId).
        const inRunAgent = getInRunAgent(ctx.runId);
        const [gate, maxResults, groups] = await Promise.all([
          inRunAgent ? gateFromAgent(inRunAgent) : gateFor(ctx.agentId),
          getMaxFindResults(),
          getEffectiveGroups(),
        ]);

        const caps = listCapabilities();
        const callable = caps.filter((c) => gate.allow.has(c.id) && lookup(c.id) !== undefined);
        const hidden = callable.filter((c) => gate.deferred.has(c.id));
        const byId = new Map(caps.map((c) => [c.id, c]));
        const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? id;
        const describe = (id: string) => gate.descriptions[id] ?? lookup(id)?.description ?? byId.get(id)?.description ?? "";

        /** The agent's own group index — what it can reach, and what's hidden
         *  where. Returned instead of an empty result so a failed search still
         *  teaches (FR-025/FR-032). */
        const groupIndex = () => {
          const counts = new Map<string, { total: number; hidden: number }>();
          for (const c of callable) {
            const e = counts.get(c.group) ?? { total: 0, hidden: 0 };
            e.total += 1;
            if (gate.deferred.has(c.id)) e.hidden += 1;
            counts.set(c.group, e);
          }
          return groups
            .filter((g) => counts.has(g.id))
            .map((g) => ({
              id: g.id,
              name: g.name,
              description: g.description,
              hiddenTools: counts.get(g.id)!.hidden,
            }));
        };

        // ── Group-scoped mode ───────────────────────────────────────────────
        let scopedGroupId: string | undefined;
        if (groupQuery) {
          const resolved = resolveGroup(groupQuery);
          if (!resolved) {
            // Never an empty result for an unknown group (FR-032).
            return JSON.stringify({
              results: [],
              totalMatches: 0,
              withheld: 0,
              error: `No tool group matches "${groupQuery}".`,
              groups: groupIndex(),
            });
          }
          scopedGroupId = resolved.id;

          if (!query) {
            // Whole group, UNCAPPED (FR-024b): maxFindResults governs free-text
            // search only. A group's size is bounded by its own declaration,
            // and with no schemas in the payload (ADR-7) returning all of it is
            // cheap — which is what makes SC-001's "one call reaches any granted
            // tool" true without pagination.
            const members = hidden.filter((c) => c.group === scopedGroupId);
            if (members.length === 0) {
              const anyInGroup = callable.some((c) => c.group === scopedGroupId);
              return JSON.stringify({
                results: [],
                totalMatches: 0,
                withheld: 0,
                message: anyInGroup
                  ? `The "${resolved.name}" group has no hidden tools for you — everything you have there is already visible.`
                  : `You have no tools in the "${resolved.name}" group.`,
                alreadyVisible: anyInGroup
                  ? callable.filter((c) => c.group === scopedGroupId).map((c) => ({ id: c.id, description: describe(c.id) }))
                  : undefined,
              });
            }
            const results: FindToolsResult[] = members.map((c) => ({
              id: c.id,
              group: groupName(c.group),
              description: describe(c.id),
              reasons: [{ term: resolved.id, field: "group" }],
            }));
            return JSON.stringify({ results, totalMatches: results.length, withheld: 0 });
          }
        }

        // ── Free-text mode (optionally restricted to a group) ───────────────
        const index = buildIndex(caps, groups);
        const outcome = search(query, index, {
          eligible: new Set(callable.map((c) => c.id)),
          groupId: scopedGroupId,
        });

        if (outcome.unsearchable) {
          return JSON.stringify({
            results: [],
            totalMatches: 0,
            withheld: 0,
            message: `"${query}" has no searchable terms (too short, or only common words). Try naming the capability, or ask for a group by name.`,
            groups: groupIndex(),
          });
        }

        const hiddenIds = new Set(hidden.map((c) => c.id));
        const matchedHidden = outcome.results.filter((r) => hiddenIds.has(r.id));
        // Above-threshold hits the agent ALREADY has visible. Reported, not
        // revealed — they need no revealing, and reporting them stops the model
        // concluding the capability doesn't exist (FR-026).
        const alreadyVisible = outcome.results
          .filter((r) => !hiddenIds.has(r.id))
          .slice(0, maxResults)
          .map((r) => ({ id: r.id, group: groupName(byId.get(r.id)?.group ?? ""), description: describe(r.id) }));

        if (matchedHidden.length === 0) {
          return JSON.stringify({
            results: [],
            totalMatches: 0,
            withheld: 0,
            message:
              alreadyVisible.length > 0
                ? "No hidden tools matched — but these tools you already have look relevant."
                : "Nothing matched. These are the tool groups you have; ask for one by name to see what it is hiding.",
            ...(alreadyVisible.length > 0 ? { alreadyVisible } : { groups: groupIndex() }),
          });
        }

        const kept = matchedHidden.slice(0, maxResults);
        const results: FindToolsResult[] = kept.map((r) => ({
          id: r.id,
          group: groupName(byId.get(r.id)?.group ?? ""),
          description: describe(r.id),
          reasons: r.reasons,
        }));
        const withheld = matchedHidden.length - kept.length;
        return JSON.stringify({
          results,
          totalMatches: matchedHidden.length,
          withheld,
          // Never a silent truncation (FR-024).
          ...(withheld > 0
            ? {
                message: `${withheld} further match${withheld === 1 ? "" : "es"} not shown. Narrow the query, or ask for the whole group by name to get all of it.`,
              }
            : {}),
          ...(alreadyVisible.length > 0 ? { alreadyVisible } : {}),
        });
      },
    ),

    find_agent: serverTool(
      "find_agent",
      "Discover sub-agents you can delegate to by natural-language query, including window-scoped surface agents from currently-open app windows. Returns each candidate agent's identity metadata (id, name, type, description, scope) — never their internal tools list. Use before agent_delegate when you don't already know which agent should handle a task.",
      schema({ query: p.str("Natural-language description of the task or specialization you need (min 2 chars).") }, ["query"]),
      async (input, ctx) => {
        const query = String(input.query ?? "").trim();
        if (query.length < 2) return JSON.stringify([]);
        const maxResults = await getMaxFindResults();
        // 025-agent-delegation-v2: merge the persisted roster with this run's
        // currently-registered surface agents (FR-010) — read per-call from
        // the run, never baked into any process-wide cache.
        const run = runManager().get(ctx.runId);
        // 048 FR-001b — find_agents exists so the model can locate a
        // specialist to delegate to. Filtering out delegate-only agents
        // would hide exactly the specialists a pack contributes.
        const persisted = (await listDelegatableAgents()).map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type as string,
          description: a.description,
          scope: "persisted" as const,
        }));
        const surface = [...(run?.agents.values() ?? [])].map((a) => ({
          id: a.id,
          name: a.name,
          type: "local",
          description: a.description,
          scope: "surface" as const,
        }));
        const candidates = [...persisted, ...surface];
        const scored = candidates
          .map((a) => ({ agent: a, score: scoreAgent({ name: a.name, description: a.description, type: a.type }, query) }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, maxResults);
        return JSON.stringify(
          scored.map(({ agent, score }) => ({
            id: agent.id,
            name: agent.name,
            type: agent.type,
            description: agent.description,
            scope: agent.scope,
            score,
          })),
        );
      },
    ),
  };
}
