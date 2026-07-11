"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "@copilotkit/react-ui";
import "@copilotkit/react-ui/styles.css";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  FolderTree,
  Hammer,
  Pencil,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import type { PipelinePhase, Specification, SpecTreeNode } from "@/lib/specs/types";
import { AssistantChatV2 } from "@/components/agent/v2/AssistantChatV2";
import { ResizeHandle } from "@/components/apps/ResizeHandle";
import { buildStudioSurfaceTools } from "./agent-tools-v2";

const LEFT_W_KEY = "bos.buildStudio.leftWidth";
const RIGHT_W_KEY = "bos.buildStudio.rightWidth";

function readStoredWidth(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const v = Number(window.localStorage.getItem(key));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

interface SpecsResponse {
  tree?: SpecTreeNode[];
  specs?: Specification[];
}

const PHASE_ORDER: PipelinePhase["id"][] = [
  "constitution",
  "specify",
  "clarify",
  "plan",
  "tasks",
  "analyze",
  "implement",
  "converge",
  "test",
];

const PHASE_LABEL: Record<PipelinePhase["id"], string> = {
  constitution: "Const",
  specify: "Spec",
  clarify: "Clarify",
  plan: "Plan",
  tasks: "Tasks",
  analyze: "Analyze",
  implement: "Impl",
  converge: "Converge",
  test: "Test",
};

function phaseClass(state: PipelinePhase["state"]): string {
  if (state === "done") return "border-emerald-500/30 bg-emerald-500/15 text-emerald-300";
  if (state === "pending") return "border-amber-500/30 bg-amber-500/10 text-amber-300";
  return "border-white/10 bg-white/5 text-white/30";
}

// A feature is identified by its store-prefixed path prefix `<storeId>/<feature>`.
function featureIdOf(path: string): string {
  return path.split("/").slice(0, 2).join("/");
}

function PhaseStrip({ phases }: { phases: PipelinePhase[] }) {
  const byId = new Map(phases.map((p) => [p.id, p.state]));
  return (
    <div className="flex flex-wrap gap-1">
      {PHASE_ORDER.map((id) => (
        <span
          key={id}
          className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${phaseClass(byId.get(id) ?? "na")}`}
          title={`${id}: ${byId.get(id) ?? "na"}`}
        >
          {PHASE_LABEL[id]}
        </span>
      ))}
    </div>
  );
}

export default function BuildStudioApp() {
  const [buildStudioAgent, setBuildStudioAgent] = useState("build-studio");
  const [tree, setTree] = useState<SpecTreeNode[]>([]);
  const [specs, setSpecs] = useState<Specification[]>([]);
  const [activeFeature, setActiveFeature] = useState<string>("");
  const [activePath, setActivePath] = useState<string>("");
  // Non-empty when viewing a DRAFT artifact from a `bos/*` store branch (020):
  // content is served from git (no checkout) and is read-only here — it lands
  // via the feature's promote in the version controls.
  const [activeBranch, setActiveBranch] = useState<string>("");
  const [content, setContent] = useState<string>("");
  const [loadedKey, setLoadedKey] = useState<string>("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [leftWidth, setLeftWidth] = useState<number>(() => readStoredWidth(LEFT_W_KEY, 224));
  const [rightWidth, setRightWidth] = useState<number>(() => readStoredWidth(RIGHT_W_KEY, 520));
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const specsRef = useRef(specs);
  useEffect(() => { specsRef.current = specs; }, [specs]);

  useEffect(() => {
    try {
      window.localStorage.setItem(LEFT_W_KEY, String(leftWidth));
    } catch {}
  }, [leftWidth]);
  useEffect(() => {
    try {
      window.localStorage.setItem(RIGHT_W_KEY, String(rightWidth));
    } catch {}
  }, [rightWidth]);

  // Scroll the active file into view whenever it changes.
  useEffect(() => {
    if (!activePath || !treeScrollRef.current) return;
    const key = activeBranch ? `${activePath}@${activeBranch}` : activePath;
    const el = treeScrollRef.current.querySelector(`[data-key="${CSS.escape(key)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activePath, activeBranch]);

  const specByPath = useMemo(() => new Map(specs.map((s) => [s.path, s])), [specs]);

  const loadTree = useCallback(() => {
    fetch("/api/specs")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as SpecsResponse;
      })
      .then((res: SpecsResponse) => {
        setTree(res.tree ?? []);
        setSpecs(res.specs ?? []);
        setError(""); // clear any stale load error (e.g. from a cold-start miss) on success
      })
      .catch(() => setError("Could not load specs."));
  }, []);

  useEffect(() => {
    fetch("/api/config/build-studio")
      .then((r) => r.json())
      .then((d) => { if (typeof d.agent === "string" && d.agent) setBuildStudioAgent(d.agent); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  const activeKey = activeBranch ? `${activePath}@${activeBranch}` : activePath;

  useEffect(() => {
    if (!activePath) return;
    const key = activeBranch ? `${activePath}@${activeBranch}` : activePath;
    let alive = true;
    fetch(`/api/specs?path=${encodeURIComponent(activePath)}${activeBranch ? `&branch=${encodeURIComponent(activeBranch)}` : ""}`)
      .then((r) => r.json())
      .then((res: { content?: string }) => {
        if (!alive) return;
        setContent(res.content ?? `Could not load "${activePath}".`);
        setLoadedKey(key);
        setEditing(false);
      })
      .catch(() => {
        if (!alive) return;
        setContent(`Could not load "${activePath}".`);
        setLoadedKey(key);
      });
    return () => {
      alive = false;
    };
  }, [activePath, activeBranch]);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const openFile = useCallback((path: string, branch = "") => {
    setActivePath(path);
    setActiveBranch(branch);
    const feature = featureIdOf(path);
    setActiveFeature(feature);
    // Collapse all other feature folders; keep only the active one expanded.
    setCollapsed((prev) => {
      const allFeatures = new Set(prev);
      // Re-collapse everything except the active feature.
      for (const key of allFeatures) allFeatures.delete(key);
      // Collapse all feature paths from the spec list, excluding the active one.
      for (const s of specsRef.current) {
        if (s.path !== feature) allFeatures.add(s.path);
      }
      return allFeatures;
    });
  }, []);

  const save = useCallback(async () => {
    if (!activePath) return;
    setSaving(true);
    setError("");
    try {
      const r = await fetch("/api/specs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: activePath, content: draft, ...(activeBranch ? { branch: activeBranch } : {}) }),
      });
      const res = await r.json();
      if (!r.ok) throw new Error(res.error || "Save failed");
      setContent(draft);
      setEditing(false);
      loadTree();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [activePath, draft, activeBranch, loadTree]);

  // Surface tools the build-studio agent can call to drive this app. Memoized so
  // the handler bindings are stable across renders (AssistantChatV2 (re)registers
  // them when the array identity changes).
  const buildStudioTools = useMemo(
    () => buildStudioSurfaceTools({ onOpen: openFile, onRefresh: loadTree }),
    [openFile, loadTree],
  );

  const activeSpec = activeFeature ? specByPath.get(activeFeature) : undefined;
  const loading = Boolean(activePath) && loadedKey !== activeKey;

  return (
    <div className="flex h-full text-sm" data-theme="dark">
      {/* Left: spec tree (resizable) */}
      <nav
        data-testid="build-studio-tree"
        style={{ width: leftWidth }}
        className="flex shrink-0 flex-col overflow-hidden border-r border-white/10 bg-white/[0.02]"
      >
        <div className="flex items-center justify-between px-3 pt-2 text-xs font-semibold uppercase tracking-wide text-white/40">
          <span className="flex items-center gap-1.5">
            <Hammer size={13} /> Build Studio
          </span>
          <button onClick={loadTree} title="Refresh" className="rounded p-1 text-white/40 hover:bg-white/10 hover:text-white/70">
            <RefreshCw size={12} />
          </button>
        </div>
        <div ref={treeScrollRef} className="min-h-0 flex-1 overflow-auto px-1 py-2">
          {tree.length === 0 ? (
            <p className="px-3 py-2 text-xs text-white/40">No specs yet. Describe a feature in the chat to create one.</p>
          ) : (
            tree.map((group) => (
              <div key={group.path} className="mb-1.5">
                <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-white/35">
                  <span className="truncate">{group.label ?? group.name}</span>
                </div>
                {group.children?.map((node) => {
                  if (node.type === "feature") {
                    const nodeKey = node.branch ? `${node.path}@${node.branch}` : node.path;
                    const isCollapsed = collapsed.has(nodeKey);
                    const spec = specByPath.get(node.path);
                    return (
                      <div key={nodeKey}>
                        <button
                          onClick={() => {
                            setActiveFeature(node.path);
                            toggle(nodeKey);
                          }}
                          className={`flex w-full items-center gap-1 rounded px-2 py-1 text-left text-xs font-medium hover:bg-white/5 ${
                            activeFeature === node.path && !activePath ? "text-white" : "text-white/70"
                          }`}
                        >
                          {isCollapsed ? <ChevronRight size={12} className="shrink-0" /> : <ChevronDown size={12} className="shrink-0" />}
                          <FolderTree size={12} className="shrink-0 opacity-60" />
                          <span className="truncate">{node.branch ? node.name : spec?.title ?? node.name}</span>
                          {node.branch && (
                            <span title={`Draft on ${node.branch} — read-only here; lands when the feature is promoted`} className="rounded bg-sky-500/20 px-1 text-[9px] font-normal normal-case text-sky-200">
                              {node.branch}
                            </span>
                          )}
                        </button>
                        {!isCollapsed &&
                          node.children?.map((child) => {
                            const childKey = child.branch ? `${child.path}@${child.branch}` : child.path;
                            return (
                              <button
                                key={childKey}
                                data-key={childKey}
                                onClick={() => openFile(child.path, child.branch ?? "")}
                                style={{ paddingLeft: 30 }}
                                className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs transition-colors ${
                                  activeKey === childKey ? "bg-white/15 text-white" : "text-white/65 hover:bg-white/10"
                                }`}
                              >
                                <FileText size={12} className="shrink-0 opacity-60" />
                                <span className="truncate">{child.name}</span>
                              </button>
                            );
                          })}
                      </div>
                    );
                  }
                  return (
                    <button
                      key={node.path}
                      data-key={node.path}
                      onClick={() => openFile(node.path)}
                      className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs transition-colors ${
                        activeKey === node.path ? "bg-white/15 text-white" : "text-white/65 hover:bg-white/10"
                      }`}
                    >
                      <FileText size={12} className="shrink-0 opacity-60" />
                      <span className="truncate">{node.name}</span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </nav>

      <ResizeHandle getWidth={() => leftWidth} setWidth={setLeftWidth} min={160} max={420} />

      {/* Center: artifact viewer / editor */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {activeSpec && (
          <div className="flex flex-col gap-1.5 border-b border-white/10 px-4 py-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-white/80">{activeSpec.title}</span>
              <span className="text-[10px] text-white/35">{activeSpec.id}</span>
            </div>
            <PhaseStrip phases={activeSpec.phases} />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto p-5">
          {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
          {!activePath ? (
            <p className="text-xs text-white/40">Select a specification on the left to view it, or use the chat to author one.</p>
          ) : loading ? (
            <p className="text-xs text-white/40">Loading…</p>
          ) : editing ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="h-full w-full resize-none rounded border border-white/10 bg-black/30 p-3 font-mono text-xs text-white/85 outline-none focus:border-white/25"
            />
          ) : (
            <article className="prose-sm max-w-none text-white/85">
              <Markdown content={content || "_(empty)_"} />
            </article>
          )}
        </div>
        {activePath && !loading && (
          <div className="flex items-center justify-between border-t border-white/10 px-4 py-1.5">
            <span className="truncate text-[10px] text-white/35">
              {activePath}
              {activeBranch ? ` @ ${activeBranch}` : ""}
            </span>
            {activeBranch ? (
              <span title="Draft branches are read-only here; promote the feature to land them" className="rounded px-2 py-1 text-[10px] text-white/40">
                read-only draft
              </span>
            ) : editing ? (
              <div className="flex gap-1">
                <button
                  onClick={save}
                  disabled={saving}
                  className="flex items-center gap-1 rounded bg-emerald-500/20 px-2 py-1 text-xs text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-50"
                >
                  <Save size={12} /> {saving ? "Saving…" : "Save"}
                </button>
                <button onClick={() => setEditing(false)} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-white/55 hover:bg-white/10">
                  <X size={12} /> Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => {
                  setDraft(content);
                  setEditing(true);
                }}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-white/60 hover:bg-white/10 hover:text-white/85"
              >
                <Pencil size={12} /> Edit
              </button>
            )}
          </div>
        )}
      </div>

      <ResizeHandle getWidth={() => rightWidth} setWidth={setRightWidth} min={340} max={820} invert />

      {/* Right (resizable): the Build Studio agent chat with its own (build-studio)
          conversation list. The agent drives this app via surface tools —
          declarations ride on each run start; handlers are dispatched back to
          this mounted surface by the server run loop. */}
      <aside style={{ width: rightWidth }} className="flex shrink-0 flex-col border-l border-white/10">
        <AssistantChatV2
          agentId={buildStudioAgent}
          showConversations
          conversationsInToolbar
          initialLabel="Describe a feature to build, or ask me to refine the selected spec."
          tools={buildStudioTools}
        />
      </aside>
    </div>
  );
}
