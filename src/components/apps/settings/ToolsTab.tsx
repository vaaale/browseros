"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AutoSaveStatus } from "./AutoSaveStatus";
import { useAutoSave } from "./hooks/useAutoSave";
import { ToolGroupList, type GroupMeta } from "./tools/ToolGroupList";

interface Capability {
  id: string;
  group: string;
  description: string;
  context: "action" | "tool" | "both";
}

interface MetadataOverride {
  description?: string;
}

type MetadataOverrides = Record<string, MetadataOverride>;

interface Payload {
  catalog: Capability[];
  overrides: MetadataOverrides;
}

// A group as /api/tool-groups reports it: registry/manifest values merged with
// the user's persisted overrides (041-tool-groups).
interface EffectiveGroup extends GroupMeta {
  description: string;
  aliases: string[];
  sourceDescription: string;
  sourceAliases: string[];
  overridden: boolean;
  origin: "builtin" | "service";
}

const MAX_FIND_RESULTS_MIN = 5;
const MAX_FIND_RESULTS_MAX = 25;
const MAX_FIND_RESULTS_DEFAULT = 10;

const TOOL_TIMEOUT_MIN = 10;
const TOOL_TIMEOUT_MAX = 3600;
const TOOL_TIMEOUT_DEFAULT = 600;

const MAX_AGENT_STEPS_MIN = 4;
const MAX_AGENT_STEPS_MAX = 200;
const MAX_AGENT_STEPS_DEFAULT = 32;

// Mirrors the server-side clamping in src/lib/config/registry.ts so the UI
// never shows a value the server would reject or rewrite.
function clampInt(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// Settings → Tools: global per-tool metadata overrides. Editing a description
// here rewrites what the LLM sees for that tool across every agent. Deferred
// visibility has no registry-wide concept — it's edited per agent in
// Settings → Agents → [agent] → Tools.
export function ToolsTab() {
  const [catalog, setCatalog] = useState<Capability[]>([]);
  // Description-only view (id → override description). The
  // bos:tool-descriptions-updated event contract still fires when a description
  // is saved so other panels (e.g. ToolManifest) can refresh.
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [groups, setGroups] = useState<EffectiveGroup[]>([]);
  const [filter, setFilter] = useState("");
  const [maxFindResults, setMaxFindResults] = useState<number>(MAX_FIND_RESULTS_DEFAULT);
  const [toolCallTimeoutSec, setToolCallTimeoutSec] = useState<number>(TOOL_TIMEOUT_DEFAULT);
  const [maxAgentSteps, setMaxAgentSteps] = useState<number>(MAX_AGENT_STEPS_DEFAULT);

  const load = useCallback(async () => {
    try {
      const res = (await fetch("/api/tool-descriptions").then((r) => r.json())) as Payload;
      setCatalog(res.catalog ?? []);
      setOverrides(descriptionMap(res.overrides ?? {}));
    } catch { /* keep previous state */ }
    try {
      const res = (await fetch("/api/tool-groups").then((r) => r.json())) as { groups?: EffectiveGroup[] };
      setGroups(res.groups ?? []);
    } catch { /* keep previous state */ }
    try {
      const res = (await fetch("/api/config").then((r) => r.json())) as {
        schemas?: { namespace: string; values?: Record<string, unknown> }[];
      };
      const tools = (res.schemas ?? []).find((s) => s.namespace === "tools");
      const v = tools?.values?.maxFindResults;
      if (typeof v === "number" && Number.isFinite(v)) {
        setMaxFindResults(clampInt(v, MAX_FIND_RESULTS_MIN, MAX_FIND_RESULTS_MAX, MAX_FIND_RESULTS_DEFAULT));
      }
      const t = tools?.values?.toolCallTimeoutSec;
      if (typeof t === "number" && Number.isFinite(t)) {
        setToolCallTimeoutSec(clampInt(t, TOOL_TIMEOUT_MIN, TOOL_TIMEOUT_MAX, TOOL_TIMEOUT_DEFAULT));
      }
      const s = tools?.values?.maxAgentSteps;
      if (typeof s === "number" && Number.isFinite(s)) {
        setMaxAgentSteps(clampInt(s, MAX_AGENT_STEPS_MIN, MAX_AGENT_STEPS_MAX, MAX_AGENT_STEPS_DEFAULT));
      }
    } catch { /* keep previous value */ }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  // Persists tools-namespace values and notifies listeners (e.g. the tool
  // kernel's timeout cache) that a tools config value changed.
  const saveToolsValue = useCallback(async (values: Record<string, number>) => {
    try {
      await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: "tools", values }),
      });
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("bos:tools-config-updated"));
      }
    } catch { /* silently keep local state */ }
  }, []);

  const saveMaxFindResults = useCallback(async (value: number) => {
    const clamped = clampInt(value, MAX_FIND_RESULTS_MIN, MAX_FIND_RESULTS_MAX, MAX_FIND_RESULTS_DEFAULT);
    setMaxFindResults(clamped);
    await saveToolsValue({ maxFindResults: clamped });
  }, [saveToolsValue]);

  const saveToolCallTimeout = useCallback(async (value: number) => {
    const clamped = clampInt(value, TOOL_TIMEOUT_MIN, TOOL_TIMEOUT_MAX, TOOL_TIMEOUT_DEFAULT);
    setToolCallTimeoutSec(clamped);
    await saveToolsValue({ toolCallTimeoutSec: clamped });
  }, [saveToolsValue]);

  const saveMaxAgentSteps = useCallback(async (value: number) => {
    const clamped = clampInt(value, MAX_AGENT_STEPS_MIN, MAX_AGENT_STEPS_MAX, MAX_AGENT_STEPS_DEFAULT);
    setMaxAgentSteps(clamped);
    await saveToolsValue({ maxAgentSteps: clamped });
  }, [saveToolsValue]);

  const patchServer = useCallback(async (patch: { id: string; description: string }) => {
    const res = await fetch("/api/tool-descriptions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error || `Failed to save (${res.status})`);
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("bos:tool-descriptions-updated"));
    }
  }, []);

  const saveDescription = useCallback(async (patch: { id: string; description: string }) => {
    await patchServer(patch);
    setOverrides((prev) => {
      const next = { ...prev };
      if (patch.description) next[patch.id] = patch.description;
      else delete next[patch.id];
      return next;
    });
  }, [patchServer]);

  const save = useAutoSave<{ id: string; description: string }>(saveDescription);

  const saveGroup = useCallback(async (patch: { groupId: string; description?: string; aliases?: string[] }) => {
    const res = await fetch("/api/tool-groups", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error || `Failed to save (${res.status})`);
    }
    setGroups((prev) =>
      prev.map((g) =>
        g.id !== patch.groupId
          ? g
          : {
              ...g,
              description: patch.description?.trim() ? patch.description : g.sourceDescription,
              aliases: patch.aliases ?? g.aliases,
              overridden: Boolean(patch.description?.trim()) || (patch.aliases ?? g.aliases).join() !== g.sourceAliases.join(),
            },
      ),
    );
  }, []);
  const groupSave = useAutoSave<{ groupId: string; description?: string; aliases?: string[] }>(saveGroup);

  // The filter matches ids, descriptions and group aliases, and auto-expands
  // whatever it matched — collapsing 20+ groups otherwise makes finding one
  // tool harder, not easier (FR-047).
  const q = filter.trim().toLowerCase();
  const visibleCatalog = useMemo(() => {
    if (!q) return catalog;
    const groupHit = new Set(
      groups
        .filter((g) => g.name.toLowerCase().includes(q) || g.aliases.some((a) => a.toLowerCase().includes(q)))
        .map((g) => g.id),
    );
    return catalog.filter(
      (t) =>
        t.id.toLowerCase().includes(q) ||
        (overrides[t.id] ?? t.description).toLowerCase().includes(q) ||
        groupHit.has(t.group),
    );
  }, [catalog, groups, overrides, q]);
  const forceOpen = useMemo(
    () => (q ? new Set(visibleCatalog.map((t) => t.group)) : undefined),
    [q, visibleCatalog],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-2">
        <p className="text-[11px] text-white/50">
          Rewrite what the LLM sees for any tool. Per-agent deferred visibility is edited in Settings → Agents.
        </p>
        <AutoSaveStatus status={groupSave.status === "saving" || groupSave.status === "error" ? groupSave.status : save.status} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mb-3 flex flex-col gap-2 rounded-md border border-white/10 bg-white/[0.03] p-2.5">
          <label className="flex items-center gap-2 text-[11px] text-white/80">
            <span className="min-w-0 flex-1">
              <span className="font-semibold text-white/90">Max discovery results</span>
              <span className="block text-[10px] text-white/50">
                Caps results returned by <span className="font-mono">find_tools</span> /{" "}
                <span className="font-mono">find_agent</span>. Range {MAX_FIND_RESULTS_MIN}–{MAX_FIND_RESULTS_MAX}, default {MAX_FIND_RESULTS_DEFAULT}.
              </span>
            </span>
            <input
              type="number"
              min={MAX_FIND_RESULTS_MIN}
              max={MAX_FIND_RESULTS_MAX}
              value={maxFindResults}
              onChange={(e) => setMaxFindResults(Number(e.target.value))}
              onBlur={(e) => void saveMaxFindResults(Number(e.target.value))}
              className="w-20 rounded border border-white/10 bg-black/30 px-2 py-1 text-right text-[11px] text-white outline-none focus:border-white/30"
            />
          </label>
          <label className="flex items-center gap-2 text-[11px] text-white/80">
            <span className="min-w-0 flex-1">
              <span className="font-semibold text-white/90">Tool call timeout (s)</span>
              <span className="block text-[10px] text-white/50">
                Max time a single tool call may run before it is aborted and reported to the agent as an error.
                Streaming tools (<span className="font-mono">agent_delegate</span>,{" "}
                <span className="font-mono">workflow_run</span>) treat this as an idle timeout.
                Range {TOOL_TIMEOUT_MIN}–{TOOL_TIMEOUT_MAX}, default {TOOL_TIMEOUT_DEFAULT}.
              </span>
            </span>
            <input
              type="number"
              min={TOOL_TIMEOUT_MIN}
              max={TOOL_TIMEOUT_MAX}
              value={toolCallTimeoutSec}
              onChange={(e) => setToolCallTimeoutSec(Number(e.target.value))}
              onBlur={(e) => void saveToolCallTimeout(Number(e.target.value))}
              className="w-20 rounded border border-white/10 bg-black/30 px-2 py-1 text-right text-[11px] text-white outline-none focus:border-white/30"
            />
          </label>
          <label className="flex items-center gap-2 text-[11px] text-white/80">
            <span className="min-w-0 flex-1">
              <span className="font-semibold text-white/90">Max agent steps</span>
              <span className="block text-[10px] text-white/50">
                Maximum model turns per agent run. Each agent (including delegated sub-agents) gets this
                many steps independently, so a run with one delegation may use up to 2× this value.
                Range {MAX_AGENT_STEPS_MIN}–{MAX_AGENT_STEPS_MAX}, default {MAX_AGENT_STEPS_DEFAULT}.
              </span>
            </span>
            <input
              type="number"
              min={MAX_AGENT_STEPS_MIN}
              max={MAX_AGENT_STEPS_MAX}
              value={maxAgentSteps}
              onChange={(e) => setMaxAgentSteps(Number(e.target.value))}
              onBlur={(e) => void saveMaxAgentSteps(Number(e.target.value))}
              className="w-20 rounded border border-white/10 bg-black/30 px-2 py-1 text-right text-[11px] text-white outline-none focus:border-white/30"
            />
          </label>
        </div>
        <label className="mb-2 flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1.5">
          <span className="text-[10px] uppercase tracking-wide text-white/40">Filter</span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="tool id, description or group"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-white outline-none placeholder:text-white/25"
          />
          {filter && (
            <button
              type="button"
              onClick={() => setFilter("")}
              className="rounded px-1.5 py-0.5 text-[10px] text-white/50 hover:bg-white/10 hover:text-white/80"
            >
              Clear
            </button>
          )}
        </label>
        <ToolGroupList
          items={visibleCatalog}
          groups={groups}
          forceOpen={forceOpen}
          emptyMessage={catalog.length === 0 ? "Loading…" : "No tools match that filter."}
          renderGroupDetail={(group) => {
            const full = groups.find((g) => g.id === group.id);
            return full ? <GroupRow key={`${full.id}:${full.description}`} group={full} onSave={groupSave.save} /> : null;
          }}
          renderItems={(items) => (
            <div className="flex flex-col gap-2">
              {items.map((tool) => (
                <ToolRow
                  key={`${tool.id}:${overrides[tool.id] ?? ""}`}
                  id={tool.id}
                  sourceDescription={tool.description}
                  override={overrides[tool.id]}
                  onSave={(description) => save.save({ id: tool.id, description })}
                />
              ))}
            </div>
          )}
        />
      </div>
    </div>
  );
}

function descriptionMap(overrides: MetadataOverrides): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, o] of Object.entries(overrides)) {
    if (typeof o.description === "string" && o.description.length > 0) out[id] = o.description;
  }
  return out;
}

function ToolRow({
  id,
  sourceDescription,
  override,
  onSave,
}: {
  id: string;
  sourceDescription: string;
  override: string | undefined;
  onSave: (description: string) => void;
}) {
  // Draft = current effective value shown to the user. Blur commits. The
  // parent remounts this row on override changes (via key prop) so we don't
  // need to sync prop→state inside an effect.
  const initial = override ?? sourceDescription;
  const [draft, setDraft] = useState(initial);

  const isOverridden = override !== undefined;

  const commit = (value: string) => {
    if (value === initial) return;
    // Empty string clears — server treats it as "reset to source".
    onSave(value.trim() === "" ? "" : value);
  };

  const reset = () => {
    setDraft(sourceDescription);
    onSave("");
  };

  return (
    <div className="rounded border border-white/10 bg-white/[0.02] p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 break-words font-mono text-[11px] text-white">{id}</span>
        </div>
        {isOverridden && (
          <button
            type="button"
            onClick={reset}
            className="rounded px-1.5 py-0.5 text-[10px] text-white/50 transition-colors hover:bg-white/10 hover:text-white/80"
          >
            Reset
          </button>
        )}
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(draft)}
        className="w-full resize-y rounded border border-white/10 bg-black/30 px-2 py-1.5 text-[13px] leading-relaxed text-white outline-none transition-colors focus:border-white/30"
        style={{ minHeight: "56px" }}
      />
      {isOverridden && (
        <div className="mt-1 text-[11px] leading-snug text-white/40">
          Source: <span className="text-white/50">{sourceDescription}</span>
        </div>
      )}
    </div>
  );
}

/** The per-group editor shown when a group is expanded (FR-045). Same
 *  draft-on-blur + reset affordance as ToolRow — a group's description feeds
 *  BOTH the system-prompt tool-group block and find_tools ranking, so editing
 *  it here is how a user steers discovery. */
function GroupRow({
  group,
  onSave,
}: {
  group: EffectiveGroup;
  onSave: (patch: { groupId: string; description?: string; aliases?: string[] }) => void;
}) {
  const [draft, setDraft] = useState(group.description);
  const [aliasDraft, setAliasDraft] = useState(group.aliases.join(", "));

  const commitDescription = (value: string) => {
    if (value === group.description) return;
    onSave({ groupId: group.id, description: value.trim() === "" ? "" : value });
  };
  const commitAliases = (value: string) => {
    const next = value.split(",").map((a) => a.trim()).filter(Boolean);
    if (next.join() === group.aliases.join()) return;
    onSave({ groupId: group.id, aliases: next });
  };

  return (
    <div className="mb-2 rounded border border-white/10 bg-white/[0.02] p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-white/40">
          Group description {group.origin === "service" && <span className="text-violet-300/70">· from item</span>}
        </span>
        {group.overridden && (
          <button
            type="button"
            onClick={() => {
              setDraft(group.sourceDescription);
              setAliasDraft(group.sourceAliases.join(", "));
              onSave({ groupId: group.id, description: "", aliases: [] });
            }}
            className="rounded px-1.5 py-0.5 text-[10px] text-white/50 transition-colors hover:bg-white/10 hover:text-white/80"
          >
            Reset
          </button>
        )}
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commitDescription(draft)}
        className="w-full resize-y rounded border border-white/10 bg-black/30 px-2 py-1.5 text-[12px] leading-relaxed text-white outline-none transition-colors focus:border-white/30"
        style={{ minHeight: "44px" }}
      />
      <label className="mt-1.5 flex items-center gap-2">
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-white/40" title="Extra words that should find this group's tools">
          Aliases
        </span>
        <input
          value={aliasDraft}
          onChange={(e) => setAliasDraft(e.target.value)}
          onBlur={() => commitAliases(aliasDraft)}
          placeholder="comma, separated, search terms"
          className="min-w-0 flex-1 rounded border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-white outline-none focus:border-white/30 placeholder:text-white/25"
        />
      </label>
      {group.overridden && (
        <div className="mt-1 text-[11px] leading-snug text-white/40">
          Source: <span className="text-white/50">{group.sourceDescription}</span>
        </div>
      )}
    </div>
  );
}
