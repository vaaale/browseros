"use client";

import { Children, isValidElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { registerAppSurfaceTools } from "@/lib/assistant/client/surface-tools";
import type { AppProps } from "@/components/apps/types";
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

// GitHub-style heading slug (the anchor `buildstudio_artifact_highlight`
// expects) — derived independently on every heading so it stays stable
// across re-renders without a rehype-slug dependency.
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

// Recurses into nested elements (bold/code/links inside a heading) so a
// formatted heading like "### `foo` Tool" produces the same text — and
// therefore the same slug — as extractHeadingAnchors gets from the raw
// markdown. Without recursion, plainText silently dropped any non-text child,
// diverging from the raw-text anchor and making buildstudio_artifact_highlight
// validate successfully while the DOM lookup for the (differently-slugged)
// rendered heading silently failed.
function plainText(children: ReactNode): string {
  return Children.toArray(children)
    .map((c) => {
      if (typeof c === "string") return c;
      if (typeof c === "number") return String(c);
      if (isValidElement<{ children?: ReactNode }>(c)) return plainText(c.props.children);
      return "";
    })
    .join("");
}

// Heading anchors that actually exist in this markdown, computed from the
// source text (not the rendered DOM) so buildstudio_artifact_highlight can
// validate an anchor synchronously and return a real error instead of
// silently doing nothing.
function extractHeadingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  let inFence = false;
  for (const line of markdown.split("\n")) {
    // Skip fenced code blocks — a "# comment"-style line inside ``` fences
    // isn't a real heading, and would otherwise validate an anchor that has
    // no corresponding rendered heading to highlight.
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) anchors.add(slugify(m[1]));
  }
  return anchors;
}

// Utility classes applied to every element in a highlighted section (the
// heading + its body content). Added/removed imperatively via classList
// rather than through React state, since the "section" a heading owns isn't
// a node in the react-markdown tree — it's a run of flat DOM siblings.
const HIGHLIGHT_CLASSES = ["bg-amber-400/15", "-mx-2", "rounded", "px-2", "transition-colors", "duration-300"];

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

export default function BuildStudioApp({ windowId }: AppProps) {
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
  // Bumped on every buildstudio_artifact_open call (even re-opening the SAME
  // path — e.g. right after an edit) and by loadTree/tree-refresh, so the
  // content-fetch effect below re-runs even when path/branch didn't change.
  // Without this, re-opening an already-active artifact after editing it (or
  // clicking refresh) left the stale pre-edit content on screen indefinitely.
  const [reloadToken, setReloadToken] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [leftWidth, setLeftWidth] = useState<number>(() => readStoredWidth(LEFT_W_KEY, 224));
  const [rightWidth, setRightWidth] = useState<number>(() => readStoredWidth(RIGHT_W_KEY, 520));
  const [highlightAnchor, setHighlightAnchor] = useState<string>("");
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const highlightedElsRef = useRef<HTMLElement[]>([]);
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
    // Refresh means refresh what's on screen, not just the tree: also force a
    // reload of the currently-open artifact's content (buildstudio_tree_refresh
    // and the manual refresh button are the only way to recover from an edit
    // that landed while this same artifact was already open).
    setReloadToken((n) => n + 1);
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
    // loadTree also bumps reloadToken (see above) — harmless here since
    // there's no open artifact yet at mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time initial fetch, not a cascading update
    loadTree();
  }, [loadTree]);

  const activeKey = activeBranch ? `${activePath}@${activeBranch}` : activePath;
  const loadKey = `${activeKey}#${reloadToken}`;
  const loading = Boolean(activePath) && loadedKey !== loadKey;

  // Mirrors of state read by highlightSection, which needs FRESH values from
  // a stable (deps-free) callback — see below for why.
  const activePathRef = useRef(activePath);
  useEffect(() => { activePathRef.current = activePath; }, [activePath]);
  const loadingRef = useRef(loading);
  useEffect(() => { loadingRef.current = loading; }, [loading]);
  const contentRef = useRef(content);
  useEffect(() => { contentRef.current = content; }, [content]);

  useEffect(() => {
    if (!activePath) return;
    const key = `${activeBranch ? `${activePath}@${activeBranch}` : activePath}#${reloadToken}`;
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
  }, [activePath, activeBranch, reloadToken]);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const openFile = useCallback((path: string, branch = "") => {
    // Set synchronously, not just via the mirroring effects below: a real
    // agent calls buildstudio_artifact_open then buildstudio_artifact_highlight
    // back-to-back, and both can be dispatched to this window in the same
    // tick — highlightSection must see the new path (and know a fetch is now
    // pending) immediately, before React has had a chance to render/commit.
    activePathRef.current = path;
    loadingRef.current = true;
    setActivePath(path);
    setActiveBranch(branch);
    // Force a fresh fetch even when re-opening the SAME path (e.g. the agent
    // edits a spec then re-opens it) — activePath/activeBranch alone wouldn't
    // change value in that case, so the content-fetch effect wouldn't re-run.
    setReloadToken((n) => n + 1);
    setHighlightAnchor("");
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

  // Deps-free (reads refs) so its identity never changes and it always sees
  // the LATEST state: a real agent calls buildstudio_artifact_open then
  // immediately buildstudio_artifact_highlight, and the artifact's content
  // fetch may still be in flight when the second call arrives — waiting out
  // that in-flight load (instead of validating against stale/empty content)
  // is the difference between a real error and a spurious one.
  //
  // Deliberately does the ENTIRE thing (validate, locate in the DOM, scroll,
  // set the highlight) itself rather than kicking off a scroll and returning
  // an optimistic "success" — the tool's return value is the ONLY feedback
  // channel back to the agent, so it must reflect what actually happened. An
  // earlier version validated against the markdown source text, returned
  // success immediately, and did the real DOM lookup later in a separate
  // effect — if THAT lookup failed (e.g. the source-text slug and the
  // rendered heading's slug ever disagree), the agent had already been told
  // it worked, with no way to find out otherwise.
  const highlightSection = useCallback(
    async (anchor: string): Promise<string> => {
      if (!activePathRef.current) return "No artifact is open — call buildstudio_artifact_open first.";
      const loadDeadline = Date.now() + 10000;
      while (loadingRef.current && Date.now() < loadDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!extractHeadingAnchors(contentRef.current).has(anchor)) {
        return `No section with anchor "${anchor}" was found in the open artifact.`;
      }
      // The anchor exists in the source text; the Markdown renderer may still
      // need a moment to paint it (or repaint after a reload) — poll the
      // actual DOM rather than assuming the text-based check is enough.
      let el: Element | null = null;
      const domDeadline = Date.now() + 3000;
      while (!el && Date.now() < domDeadline) {
        await new Promise((r) => requestAnimationFrame(r));
        el = viewerRef.current?.querySelector(`#${CSS.escape(anchor)}`) ?? null;
      }
      if (!el) {
        return `Found "${anchor}" in the spec text, but could not locate the rendered heading to highlight it. Try calling buildstudio_artifact_highlight again.`;
      }
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      setHighlightAnchor(anchor);
      return `Scrolling to and highlighting "${anchor}" in the Build Studio viewer.`;
    },
    [],
  );

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

  // Surface tools the build-studio agent can call to drive this app —
  // registered against this window's id so they're available to any run while
  // this window is open, regardless of which chat pane started it (013-build-
  // studio-agentic V2 surface-tools registry).
  // highlightSection only reads refs asynchronously, inside its own handler body, once
  // actually invoked later by the run loop; buildStudioSurfaceTools just stores the
  // reference here (declarations + handlers) — it never calls it during this render.
  const buildStudioTools = useMemo(
    () => buildStudioSurfaceTools({ onOpen: openFile, onHighlight: highlightSection, onRefresh: loadTree }), // eslint-disable-line react-hooks/refs
    [openFile, highlightSection, loadTree],
  );
  useEffect(() => registerAppSurfaceTools(windowId, buildStudioTools), [windowId, buildStudioTools]);

  const activeSpec = activeFeature ? specByPath.get(activeFeature) : undefined;

  // Apply the highlight to the WHOLE section — the heading plus its rendered
  // siblings up to (not including) the next heading of equal-or-higher level
  // — via direct DOM classList manipulation. react-markdown renders a flat
  // sibling list, not a nested section tree, so there's no single React node
  // to attach a "highlighted" prop to; walking siblings post-render is the
  // simplest way to find a section's extent. No timeout: clearing happens
  // only via the click handler below.
  useEffect(() => {
    for (const el of highlightedElsRef.current) el.classList.remove(...HIGHLIGHT_CLASSES);
    highlightedElsRef.current = [];
    if (!highlightAnchor || !viewerRef.current) return;
    const heading = viewerRef.current.querySelector(`#${CSS.escape(highlightAnchor)}`);
    if (!heading) return;
    const level = Number(heading.tagName.slice(1));
    const section: HTMLElement[] = [heading as HTMLElement];
    for (let sib = heading.nextElementSibling; sib; sib = sib.nextElementSibling) {
      if (/^H[1-6]$/.test(sib.tagName) && Number(sib.tagName.slice(1)) <= level) break;
      section.push(sib as HTMLElement);
    }
    for (const el of section) el.classList.add(...HIGHLIGHT_CLASSES);
    highlightedElsRef.current = section;
  }, [highlightAnchor, content]);

  // Click-to-dismiss: the ONLY way the highlight clears. Delegated to the
  // viewer container so it works regardless of which element inside the
  // highlighted section was clicked.
  const onViewerClick = useCallback((e: React.MouseEvent) => {
    if (!highlightAnchor) return;
    const target = e.target as HTMLElement;
    if (highlightedElsRef.current.some((el) => el === target || el.contains(target))) {
      setHighlightAnchor("");
    }
  }, [highlightAnchor]);

  // react-markdown heading override: just the stable id. Highlighting is
  // applied imperatively above, to the whole section, not just the heading.
  const headingComponents = useMemo(() => {
    const heading = (level: 1 | 2 | 3 | 4 | 5 | 6) =>
      function Heading({ children }: { children?: ReactNode }) {
        const Tag = `h${level}` as const;
        return <Tag id={slugify(plainText(children))}>{children}</Tag>;
      };
    return {
      h1: heading(1),
      h2: heading(2),
      h3: heading(3),
      h4: heading(4),
      h5: heading(5),
      h6: heading(6),
    };
  }, []);

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
        <div ref={viewerRef} onClick={onViewerClick} className="min-h-0 flex-1 overflow-auto p-5">
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
              <Markdown content={content || "_(empty)_"} components={headingComponents} />
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
        />
      </aside>
    </div>
  );
}
