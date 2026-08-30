"use client";

import { Children, isValidElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Markdown } from "@copilotkit/react-ui";
import "@copilotkit/react-ui/styles.css";
import { markdownRenderers } from "@/components/agent/MarkdownRenderers";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderTree,
  Hammer,
  Pencil,
  RefreshCw,
  Save,
  Search,
  X,
} from "lucide-react";
import type { PipelinePhase, Specification, SpecTreeNode } from "@/lib/specs/types";
import { AssistantChatV2 } from "@/components/agent/v2/AssistantChatV2";
import { ResizeHandle } from "@/components/apps/ResizeHandle";
import { registerAppSurfaceTools } from "@/lib/assistant/client/surface-tools";
import { useActiveConversation, selectConversationById } from "@/lib/agent/conversations";
import type { AppProps } from "@/components/apps/types";
import { buildStudioSurfaceTools } from "./agent-tools-v2";
import { featureIdOf, findBranchInTree, findInTree, storeIdOf } from "./tree-helpers";
import { ContextMenu, ConfirmDialog, PromptDialog, type MenuItem } from "./Dialogs";
import { HistoryDialog } from "./HistoryDialog";
import { ConflictPane } from "./conflict/ConflictPane";
import { findActiveConflictSession } from "./conflict/useConflictSession";
import type { ConflictSession } from "@/lib/gitops/sessions/types";

const LEFT_W_KEY = "bos.buildStudio.leftWidth";
const RIGHT_W_KEY = "bos.buildStudio.rightWidth";

// Must match the left ResizeHandle's own `min` (below) — the right pane's
// viewport-aware max (FR-006/007) is computed against this floor, not the
// left pane's current width, so the center viewer is protected even in the
// worst case where the left pane is also dragged down to its minimum.
const LEFT_MIN_W = 160;
const RIGHT_MIN_W = 340;
// The smallest width the center artifact viewer is ever allowed to be
// squeezed to. 160 is the largest floor that still lets the chat pane widen
// to >=1100px on a >=1440px window (FR-006/SC-003: 1440 - LEFT_MIN_W - 160 =
// 1120) while guaranteeing the center viewer never fully collapses.
const CENTER_MIN_FLOOR = 160;

function readStoredWidth(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const v = Number(window.localStorage.getItem(key));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

// The `NNN-` numbering prefix of a feature folder's slug (e.g. "035" from
// "035-spec-promote-conflict") — shown alongside the resolved spec title so
// similarly-titled features stay identifiable at a glance instead of only by
// (often near-identical) title text.
function featureNumberPrefix(name: string): string {
  const m = /^(\d+)-/.exec(name);
  return m ? m[1] : "";
}

// A node matches the search box against whichever text the user is likely to
// type: its raw name/slug, its label (a Project's human label), or — for a
// feature — its resolved spec title, which usually differs from the slug.
function nodeMatchesSearch(node: SpecTreeNode, query: string, specByPath: Map<string, Specification>): boolean {
  const candidates = [node.name, node.label, node.type === "feature" ? specByPath.get(node.path)?.title : undefined];
  return candidates.some((s) => typeof s === "string" && s.toLowerCase().includes(query));
}

// Prune the tree to nodes that match `query` themselves, or contain a
// descendant that does. A node that matches itself keeps its FULL original
// children (searching for a folder should reveal everything inside it); an
// unmatched ancestor-of-a-match keeps only the matching descendants, so the
// result stays a real path down to each hit rather than the whole subtree.
function filterTreeNodes(nodes: SpecTreeNode[], query: string, specByPath: Map<string, Specification>): SpecTreeNode[] {
  const out: SpecTreeNode[] = [];
  for (const node of nodes) {
    const selfMatch = nodeMatchesSearch(node, query, specByPath);
    if (node.type === "file") {
      if (selfMatch) out.push(node);
      continue;
    }
    if (selfMatch) {
      out.push(node);
      continue;
    }
    const childMatches = node.children ? filterTreeNodes(node.children, query, specByPath) : [];
    if (childMatches.length > 0) out.push({ ...node, children: childMatches });
  }
  return out;
}

function phaseClass(state: PipelinePhase["state"]): string {
  if (state === "done") return "border-emerald-500/30 bg-emerald-500/15 text-emerald-300";
  if (state === "pending") return "border-amber-500/30 bg-amber-500/10 text-amber-300";
  return "border-white/10 bg-white/5 text-white/30";
}

// A store group's type — System/User specs are core, Marketplace is a whole
// cloned spec store, Item is one installed item's own bundled spec (spec/
// facet, discovered from item-stores.ts). Distinct colors per kind.
const OWNER_LABEL: Record<string, string> = { system: "System", user: "User", marketplace: "Marketplace", item: "Item" };
const OWNER_BADGE_CLASS: Record<string, string> = {
  system: "bg-violet-500/20 text-violet-200",
  user: "bg-emerald-500/20 text-emerald-200",
  marketplace: "bg-amber-500/20 text-amber-200",
  item: "bg-sky-500/20 text-sky-200",
};

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

export default function BuildStudioApp({ windowId, params }: AppProps) {
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
  const [treeSearch, setTreeSearch] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [leftWidth, setLeftWidth] = useState<number>(() => readStoredWidth(LEFT_W_KEY, 224));
  const [rightWidth, setRightWidth] = useState<number>(() => readStoredWidth(RIGHT_W_KEY, 520));
  // The app root's own content width (not the browser window's — BOS windows
  // are independently resizable), tracked so the chat pane's max can adapt
  // (FR-006/007) instead of using the old fixed 820px cap. Falls back to the
  // browser viewport width until the root node is measured, which happens
  // synchronously on mount via the callback ref below.
  const [rootWidth, setRootWidth] = useState<number>(() => (typeof window !== "undefined" ? window.innerWidth : 1440));
  const rootResizeObserverRef = useRef<ResizeObserver | null>(null);
  const setRootRef = useCallback((node: HTMLDivElement | null) => {
    rootResizeObserverRef.current?.disconnect();
    rootResizeObserverRef.current = null;
    if (!node) return;
    setRootWidth(node.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setRootWidth(width);
    });
    ro.observe(node);
    rootResizeObserverRef.current = ro;
  }, []);
  // Right pane's viewport-aware maximum (FR-006): whatever's left of the root
  // width after reserving the left pane's own minimum and the center floor,
  // never less than the right pane's own minimum (FR-007's invariant, best-
  // effort once the window is too narrow to satisfy every minimum at once).
  const rightMaxWidth = Math.max(RIGHT_MIN_W, rootWidth - LEFT_MIN_W - CENTER_MIN_FLOOR);
  // Re-clamp a persisted width into the current valid range whenever the
  // range changes (window resized since it was saved) — FR-008.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-clamping into a range that itself just changed, not a cascading update
    setRightWidth((w) => clamp(w, RIGHT_MIN_W, rightMaxWidth));
  }, [rightMaxWidth]);
  const [highlightAnchor, setHighlightAnchor] = useState<string>("");
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [promptDialog, setPromptDialog] = useState<{
    title: string;
    message?: string;
    prefix?: string;
    initialValue?: string;
    confirmLabel?: string;
    onConfirm: (value: string) => void | Promise<void>;
  } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
    onConfirm: () => void | Promise<void>;
  } | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [historyPath, setHistoryPath] = useState<string>("");
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const highlightedElsRef = useRef<HTMLElement[]>([]);
  const specsRef = useRef(specs);
  useEffect(() => { specsRef.current = specs; }, [specs]);
  const treeRef = useRef(tree);
  useEffect(() => { treeRef.current = tree; }, [tree]);

  // user-specs' write-gating branch: the SAME "Active feature branch" this
  // window's own embedded chat conversation already exposes (its
  // FeatureBranchSelector dropdown, below) — no separate Build Studio picker
  // needed. There is no more per-Project activation for this store; the
  // whole store is editable, or not, based on this ONE value.
  const conv = useActiveConversation(buildStudioAgent);
  const userBranch = conv?.activeFeatureBranch ?? "";
  const userBranchRef = useRef(userBranch);
  useEffect(() => { userBranchRef.current = userBranch; }, [userBranch]);

  // ── Conflict-resolution pane (035, D1/D5) ────────────────────────────────
  //
  // While a session is active the pane OWNS the centre column (the artifact
  // viewer is hidden, the left spec tree stays), and the right column's
  // EXISTING chat is re-pointed at the session's conversation — that chat is
  // the agent↔user channel (FR-007a), not a second mechanism.
  //
  // Two ways in, converging on the same session id:
  //  - `params.sessionId`, set by the topbar auto-launcher (the fast path);
  //  - a query of the session store on mount, which is what restores the pane
  //    after a plain browser refresh with no event re-emit (FR-024).
  const paneParam = typeof params?.pane === "string" ? (params.pane as string) : "";
  const sessionIdParam =
    paneParam === "conflict" && typeof params?.sessionId === "string" ? (params.sessionId as string) : "";
  const [conflictSessionId, setConflictSessionId] = useState<string>(sessionIdParam);
  const [conflictAgentId, setConflictAgentId] = useState<string>("");
  const [conflictDismissed, setConflictDismissed] = useState(false);

  useEffect(() => {
    if (sessionIdParam) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConflictSessionId(sessionIdParam);
      setConflictDismissed(false);
    }
  }, [sessionIdParam]);

  useEffect(() => {
    if (sessionIdParam || conflictSessionId) return;
    let alive = true;
    void findActiveConflictSession().then((s) => {
      if (alive && s) setConflictSessionId(s.id);
    });
    return () => {
      alive = false;
    };
  }, [sessionIdParam, conflictSessionId]);

  // Bind the existing chat to the session's conversation. The conversation was
  // created server-side by the escalation, so a browser that was already open
  // has never listed it — selectConversationById re-reads the VFS first.
  useEffect(() => {
    if (!conflictSessionId) return;
    let alive = true;
    void fetch(`/api/gitops/sessions?id=${encodeURIComponent(conflictSessionId)}`)
      .then((r) => r.json())
      .then((d: { session?: ConflictSession }) => {
        if (!alive || !d.session) return;
        setConflictAgentId(d.session.agentId);
        void selectConversationById(d.session.conversationId);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [conflictSessionId]);

  const showConflictPane = !conflictDismissed && !!conflictSessionId;
  const onConflictSettled = useCallback((s: ConflictSession) => {
    // Terminal ⇒ the centre reverts to the artifact viewer, but not until the
    // user has had a moment to read the outcome banner.
    if (s.status === "resolved" || s.status === "abandoned") {
      setTimeout(() => setConflictDismissed(true), 6000);
    }
  }, []);

  // user-apps items have no activation state of their own any more: their
  // content lives in `data/user-apps`, a branch-coupled repo mounted on the
  // active feature branch, so an item is editable exactly when a feature
  // branch is selected — the SAME condition as user-specs (see `canEdit`).
  // The old per-item Activate/Promote/Discard menu drove the Supervisor's
  // global app-candidate branch, which is retired.

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

  // Awaitable form — returns the freshly-fetched tree directly rather than
  // relying on the caller reading treeRef.current right after, since a
  // setTree() doesn't sync treeRef until the next render/effect commits.
  // openArtifactForAgent (below) needs the actual fetched value in hand to
  // retry a branch lookup against it in the same tick.
  const refreshTree = useCallback(async (): Promise<SpecTreeNode[]> => {
    setReloadToken((n) => n + 1);
    try {
      // Send the active feature branch: the ITEM-store part of the tree is read
      // from that branch's coupled user-apps worktree, which is where its writes
      // go. Without it the sidebar shows base's stale copy.
      const branch = userBranchRef.current;
      const r = await fetch(`/api/specs${branch ? `?branch=${encodeURIComponent(branch)}` : ""}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const res = (await r.json()) as SpecsResponse;
      setTree(res.tree ?? []);
      setSpecs(res.specs ?? []);
      setError(""); // clear any stale load error (e.g. from a cold-start miss) on success
      return res.tree ?? [];
    } catch {
      setError("Could not load specs.");
      return treeRef.current;
    }
  }, []);

  const loadTree = useCallback(() => {
    // Refresh means refresh what's on screen, not just the tree: also force a
    // reload of the currently-open artifact's content (buildstudio_tree_refresh
    // and the manual refresh button are the only way to recover from an edit
    // that landed while this same artifact was already open). Fire-and-forget
    // for callers that don't need the result (mount effect, refresh button).
    void refreshTree();
  }, [refreshTree]);

  // Re-read the tree whenever the active feature branch changes. An item
  // store's artifacts are read THROUGH the branch, so activating one
  // mid-session — exactly what happens when the agent elicits a branch — or
  // switching branch changes what the sidebar should show. Without this the
  // tree keeps showing the previously-resolved copy until a manual refresh:
  // the stale-listing half of the read/write desync.
  const lastTreeBranch = useRef(userBranch);
  useEffect(() => {
    if (lastTreeBranch.current === userBranch) return;
    lastTreeBranch.current = userBranch;
    loadTree();
  }, [userBranch, loadTree]);

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

  // EVERY container starts collapsed, at every depth — not just each store's
  // top-level Projects. A fully-expanded tree (every project, every nested
  // folder, every feature) is unusable to scan on first open, and leaving any
  // level un-collapsed by default meant expanding its ancestor immediately
  // revealed that whole already-expanded subtree instead of just its direct
  // children. Applies once per window open (a ref, not tied to loadTree
  // itself), so a later refresh/tool call never clobbers whatever the user
  // has since expanded or collapsed by hand.
  const initialCollapseAppliedRef = useRef(false);
  useEffect(() => {
    if (initialCollapseAppliedRef.current || tree.length === 0) return;
    initialCollapseAppliedRef.current = true;
    const toCollapse: string[] = [];
    const walk = (nodes: SpecTreeNode[]) => {
      for (const node of nodes) {
        if (node.type === "file") continue;
        toCollapse.push(node.branch ? `${node.path}@${node.branch}` : node.path);
        if (node.children) walk(node.children);
      }
    };
    for (const group of tree) walk(group.children ?? []);
    if (toCollapse.length === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time initial default, not a cascading update
    setCollapsed((prev) => {
      const next = new Set(prev);
      for (const p of toCollapse) next.add(p);
      return next;
    });
  }, [tree]);

  const activeKey = activeBranch ? `${activePath}@${activeBranch}` : activePath;
  const loadKey = `${activeKey}#${reloadToken}`;
  const loading = Boolean(activePath) && loadedKey !== loadKey;
  // An HTML artifact (a UI mockup, most commonly) is rendered live rather than
  // as markdown/raw text — content is already fetched branch-scoped via
  // /api/specs above, so this is a plain srcDoc render with no separate fetch
  // (and none of api/fs/raw's branch-scoping concerns) needed.
  const isHtmlPath = /\.html?$/i.test(activePath);

  // Mirrors of state read by highlightSection, which needs FRESH values from
  // a stable (deps-free) callback — see below for why.
  const activePathRef = useRef(activePath);
  useEffect(() => { activePathRef.current = activePath; }, [activePath]);
  const loadingRef = useRef(loading);
  useEffect(() => { loadingRef.current = loading; }, [loading]);
  const contentRef = useRef(content);
  useEffect(() => { contentRef.current = content; }, [content]);

  // The store the currently open file belongs to, if any (undefined while the
  // tree hasn't loaded that path's group yet). `liveBranch` is the REAL,
  // writable branch this file is being edited on — distinct from
  // `activeBranch` above, which is the read-only `bos/*` DRAFT viewer (020,
  // git-show, no checkout). Non-empty for any WRITABLE store: user-specs and
  // item-owned stores are both branch-coupled repos. bos-system-specs is never
  // writable at all.
  const activeGroup = activePath ? tree.find((g) => g.path === storeIdOf(activePath)) : undefined;
  const liveBranch = activeGroup?.writable ? userBranch : "";
  // Writable at all (never true for bos-system-specs), AND a real feature
  // branch is selected — the same condition for every writable store now.
  const canEdit = Boolean(activeGroup?.writable) && Boolean(liveBranch);

  useEffect(() => {
    if (!activePath) return;
    const key = `${activeBranch ? `${activePath}@${activeBranch}` : activePath}#${reloadToken}`;
    let alive = true;
    const params = new URLSearchParams({ path: activePath });
    if (activeBranch) params.set("branch", activeBranch);
    else if (liveBranch) params.set("liveBranch", liveBranch);
    fetch(`/api/specs?${params}`)
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
  }, [activePath, activeBranch, liveBranch, reloadToken]);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const openFile = useCallback((path: string, branch = "") => {
    // When called from the tool (no branch arg), look up the draft branch from
    // the tree so specs that only exist in a worktree are fetched correctly.
    const draftBranch = branch || findBranchInTree(treeRef.current, path);
    // A draft node's branch matching user-specs' OWN currently-selected live
    // branch isn't a foreign, read-only preview — it's this window's own
    // in-progress work (e.g. the agent just wrote it via file_write on the
    // SAME branch), which only shows up as a "draft" at all because it
    // hasn't been promoted to base yet. Open it live instead: leave
    // activeBranch empty so liveBranch (derived from userBranch) supplies
    // the branch for editing/saving, rather than falling into the read-only
    // draft-viewer path meant for OTHER branches (or bos-system-specs, which
    // has no live-editing concept at all and always uses this path).
    const group = treeRef.current.find((g) => g.path === storeIdOf(path));
    const isOwnLiveBranch = group?.owner === "user" && Boolean(draftBranch) && draftBranch === userBranchRef.current;
    const resolvedBranch = isOwnLiveBranch ? "" : draftBranch;
    // Set synchronously, not just via the mirroring effects below: a real
    // agent calls buildstudio_artifact_open then buildstudio_artifact_highlight
    // back-to-back, and both can be dispatched to this window in the same
    // tick — highlightSection must see the new path (and know a fetch is now
    // pending) immediately, before React has had a chance to render/commit.
    activePathRef.current = path;
    loadingRef.current = true;
    setActivePath(path);
    setActiveBranch(resolvedBranch);
    // Force a fresh fetch even when re-opening the SAME path (e.g. the agent
    // edits a spec then re-opens it) — activePath/activeBranch alone wouldn't
    // change value in that case, so the content-fetch effect wouldn't re-run.
    setReloadToken((n) => n + 1);
    setHighlightAnchor("");
    const feature = featureIdOf(path, treeRef.current);
    setActiveFeature(feature);
    // Expand every ancestor container (project / plain folder / feature) of
    // the newly active file, leaving the rest of the tree as the user left
    // it — containers can now nest to arbitrary depth (037-project-layer),
    // so "collapse everything except the active one" no longer applies
    // cleanly the way it did with a flat feature list.
    const match = findInTree(treeRef.current, path);
    if (match) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        for (const ancestor of match.ancestors) next.delete(ancestor.path);
        return next;
      });
    }
  }, []);

  // The buildstudio_artifact_open tool's actual handler — unlike openFile
  // (a synchronous state-setter used by clicks in this same render), this is
  // the ONLY feedback channel back to the agent, so it must reflect what
  // actually happened, the same principle highlightSection below already
  // follows. A real session hit this for real: it opened a design.md an
  // architect sub-agent had just written on a draft feature branch, and the
  // tool reported "Opened" while the viewer showed nothing, because this
  // window's tree was fetched before that write landed and openFile's branch
  // lookup silently found no match. Waits for the load, and — only if it
  // failed — refreshes the tree once and retries before giving up, instead of
  // reporting success the instant a fetch is merely kicked off.
  const openArtifactForAgent = useCallback(
    async (path: string): Promise<string> => {
      const waitForLoad = async () => {
        const deadline = Date.now() + 10000;
        while (loadingRef.current && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      const failed = () => contentRef.current.startsWith('Could not load "');

      openFile(path);
      await waitForLoad();

      if (failed()) {
        const freshTree = await refreshTree();
        openFile(path, findBranchInTree(freshTree, path));
        await waitForLoad();
      }

      if (failed()) {
        return `Could not open "${path}" in the Build Studio viewer: ${contentRef.current} Check the path is store-prefixed and correct (e.g. "user-specs/<id>/design.md"), and that the file has actually been written — a stale tree was already retried once.`;
      }
      return `Opened ${path} in the Build Studio viewer.`;
    },
    [openFile, refreshTree],
  );

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
        // Race rAF against a 100 ms timeout so the loop always makes progress
        // even when rAF is suspended (minimized window, hidden tab).
        await Promise.race([
          new Promise<void>((r) => requestAnimationFrame(() => r())),
          new Promise<void>((r) => setTimeout(r, 100)),
        ]);
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
      // liveBranch is read directly from this window's own embedded chat
      // conversation on every render (useActiveConversation) — always fresh,
      // no staleness to guard against the way the old per-Project session
      // lookup needed to.
      const r = await fetch("/api/specs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: activePath, content: draft, ...(liveBranch ? { branch: liveBranch } : {}) }),
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
  }, [activePath, draft, liveBranch, loadTree]);

  // --- File actions: rename / delete / history --------------------------
  // A non-writable store's file gets no menu at all (openFileMenu bails out
  // before ever calling setMenu — right-clicking a system spec does
  // nothing). EVERY writable store — user-specs and item-owned alike — needs
  // this window's own live branch (userBranchRef) set, since both are
  // branch-coupled repos that commit onto the active feature branch.

  /** The real feature branch (if any) a write to `path` should land on —
   *  non-empty for any WRITABLE store (user-specs and item-owned alike, both
   *  branch-coupled); empty for bos-system-specs, which is never writable, so
   *  irrelevant. */
  function liveBranchForPath(path: string): string {
    const group = treeRef.current.find((g) => g.path === storeIdOf(path));
    return group?.writable ? userBranchRef.current : "";
  }

  const renameFileAction = useCallback(
    (node: SpecTreeNode) => {
      const dir = node.path.split("/").slice(0, -1).join("/");
      const branch = liveBranchForPath(node.path);
      setDialogError("");
      setPromptDialog({
        title: "Rename file",
        initialValue: node.name,
        confirmLabel: "Rename",
        onConfirm: async (newName) => {
          setDialogBusy(true);
          setDialogError("");
          try {
            const to = `${dir}/${newName}`;
            const r = await fetch("/api/specs", {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ path: node.path, to, ...(branch ? { branch } : {}) }),
            });
            const res = await r.json();
            if (!r.ok) throw new Error(res.error || "Rename failed.");
            setPromptDialog(null);
            if (activePath === node.path) setActivePath(to);
            loadTree();
          } catch (e) {
            setDialogError((e as Error).message);
          } finally {
            setDialogBusy(false);
          }
        },
      });
    },
    [loadTree, activePath],
  );

  const deleteFileAction = useCallback(
    (node: SpecTreeNode) => {
      const branch = liveBranchForPath(node.path);
      setDialogError("");
      setConfirmDialog({
        title: `Delete "${node.name}"?`,
        message: "This can be undone via View History only if a prior commit still has it.",
        confirmLabel: "Delete",
        danger: true,
        onConfirm: async () => {
          setDialogBusy(true);
          setDialogError("");
          try {
            const params = new URLSearchParams({ path: node.path });
            if (branch) params.set("branch", branch);
            const r = await fetch(`/api/specs?${params}`, { method: "DELETE" });
            const res = await r.json();
            if (!r.ok) throw new Error(res.error || "Delete failed.");
            setConfirmDialog(null);
            if (activePath === node.path) setActivePath("");
            loadTree();
          } catch (e) {
            setDialogError((e as Error).message);
          } finally {
            setDialogBusy(false);
          }
        },
      });
    },
    [loadTree, activePath],
  );

  const openFileMenu = useCallback(
    (e: React.MouseEvent, node: SpecTreeNode) => {
      e.preventDefault();
      e.stopPropagation();
      const group = treeRef.current.find((g) => g.path === storeIdOf(node.path));
      if (!group?.writable) return; // read-only store — right-click does nothing
      const active = group.owner === "item" ? true : Boolean(userBranchRef.current);
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: "View history", onSelect: () => setHistoryPath(node.path) },
          { label: "Rename", disabled: !active, onSelect: () => renameFileAction(node) },
          { label: "Delete", disabled: !active, danger: true, onSelect: () => deleteFileAction(node) },
        ],
      });
    },
    [renameFileAction, deleteFileAction],
  );

  // Surface tools the build-studio agent can call to drive this app —
  // registered against this window's id so they're available to any run while
  // this window is open, regardless of which chat pane started it (013-build-
  // studio-agentic V2 surface-tools registry).
  // highlightSection and liveBranchForPath only read refs inside their own handler
  // bodies, once actually invoked later by the run loop; buildStudioSurfaceTools
  // just stores the reference here (declarations + handlers) — it never calls
  // them during this render.
  const buildStudioTools = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs
      buildStudioSurfaceTools({
        onOpen: openArtifactForAgent,
        onHighlight: highlightSection,
        onRefresh: loadTree,
        getBranch: liveBranchForPath,
      }),
    [openArtifactForAgent, highlightSection, loadTree],
  );
  useEffect(() => registerAppSurfaceTools(windowId, buildStudioTools), [windowId, buildStudioTools]);

  const activeSpec = activeFeature ? specByPath.get(activeFeature) : undefined;
  const treeQuery = treeSearch.trim().toLowerCase();
  const isSearchingTree = Boolean(treeQuery);

  // Recursive tree-node renderer (037-project-layer): a store's children are
  // now Projects, which can hold arbitrarily nested plain folders down to a
  // feature leaf's files — replaces the old fixed 2-level (feature -> file)
  // unrolled rendering. "project"/"dir" are both plain expand/collapse
  // containers; "feature" additionally resolves a Specification for its
  // title/phases; "file" is the only leaf, with its own context menu.
  const renderNode = (node: SpecTreeNode, depth: number, forceExpand = false): ReactNode => {
    const nodeKey = node.branch ? `${node.path}@${node.branch}` : node.path;
    const paddingLeft = 8 + depth * 14;

    if (node.type === "file") {
      return (
        <button
          key={nodeKey}
          data-key={nodeKey}
          data-node-type="file"
          onClick={() => openFile(node.path, node.branch ?? "")}
          onContextMenu={(e) => openFileMenu(e, node)}
          style={{ paddingLeft }}
          className={`flex w-full items-center gap-1.5 rounded py-1 text-left text-xs transition-colors ${
            activeKey === nodeKey ? "bg-white/15 text-white" : "text-white/65 hover:bg-white/10"
          }`}
        >
          <FileText size={12} className="shrink-0 opacity-60" />
          <span className="truncate">{node.name}</span>
        </button>
      );
    }

    // project / dir / feature — all containers with an expand/collapse chevron.
    // While a search is active every matched node is force-expanded (there's
    // no point making the user manually expand down to a filtered result).
    const isCollapsed = forceExpand ? false : collapsed.has(nodeKey);
    const spec = node.type === "feature" ? specByPath.get(node.path) : undefined;
    // No container node has a git-activation menu any more: Projects are pure
    // organizational folders, and an item-owned group's synthetic feature node
    // used to drive user-apps' app-candidate branch, which is retired. Both
    // user-specs and item stores now commit onto the chat's active feature
    // branch, so activation state is that branch — shown once, in the chat's
    // "Active feature branch" dropdown, not per-node.
    // A draft-grafted node whose branch is user-specs' OWN currently-selected
    // live branch isn't a foreign, read-only preview (see openFile's matching
    // check) — don't badge it as one, and resolve its real title same as any
    // other feature node instead of showing the raw folder name.
    const isForeignDraft = Boolean(node.branch) && !(tree.find((g) => g.path === storeIdOf(node.path))?.owner === "user" && node.branch === userBranch);
    // A resolved spec title reads better than the raw slug, but on its own it
    // drops the "NNN-" numbering that makes similarly-titled features
    // identifiable at a glance — prefix it back on whenever a title is shown.
    const featureNumber = node.type === "feature" ? featureNumberPrefix(node.name) : "";
    const label = isForeignDraft
      ? node.name
      : node.type === "feature"
        ? spec?.title
          ? featureNumber
            ? `${featureNumber} · ${spec.title}`
            : spec.title
          : node.name
        : (node.label ?? node.name);

    return (
      <div key={nodeKey}>
        <button
          data-key={nodeKey}
          data-node-type={node.type}
          onClick={() => {
            if (node.type === "feature") setActiveFeature(node.path);
            toggle(nodeKey);
          }}
          style={{ paddingLeft }}
          className={`flex w-full items-center gap-1 rounded py-1 text-left text-xs font-medium hover:bg-white/5 ${
            node.type === "feature" && activeFeature === node.path && !activePath ? "text-white" : "text-white/70"
          }`}
        >
          {isCollapsed ? <ChevronRight size={12} className="shrink-0" /> : <ChevronDown size={12} className="shrink-0" />}
          {node.type === "feature" ? <FolderTree size={12} className="shrink-0 opacity-60" /> : <Folder size={12} className="shrink-0 opacity-60" />}
          <span className="truncate">{label}</span>
          {isForeignDraft && (
            <span
              title={`Draft on ${node.branch} — read-only here; lands when the feature is promoted`}
              className="shrink-0 rounded bg-sky-500/20 px-1 text-[9px] font-normal normal-case text-sky-200"
            >
              {node.branch}
            </span>
          )}
        </button>
        {!isCollapsed && node.children?.map((child) => renderNode(child, depth + 1, forceExpand))}
      </div>
    );
  };

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
      ...markdownRenderers,
      h1: heading(1),
      h2: heading(2),
      h3: heading(3),
      h4: heading(4),
      h5: heading(5),
      h6: heading(6),
    };
  }, []);

  return (
    <div ref={setRootRef} className="flex h-full text-sm" data-theme="dark">
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
        <div className="relative px-2 pt-2">
          <Search size={12} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/30" />
          <input
            data-testid="build-studio-tree-search"
            value={treeSearch}
            onChange={(e) => setTreeSearch(e.target.value)}
            placeholder="Filter specs…"
            className="w-full rounded border border-white/10 bg-black/20 py-1 pl-6 pr-2 text-xs text-white/80 placeholder:text-white/30 outline-none focus:border-white/25"
          />
        </div>
        <div ref={treeScrollRef} className="min-h-0 flex-1 overflow-auto px-1 py-2">
          {tree.length === 0 ? (
            <p className="px-3 py-2 text-xs text-white/40">No specs yet. Describe a feature in the chat to create one.</p>
          ) : (
            <>
              {tree
                .filter((group) => group.owner !== "item")
                .map((group) => {
                  const children = isSearchingTree ? filterTreeNodes(group.children ?? [], treeQuery, specByPath) : (group.children ?? []);
                  if (isSearchingTree && children.length === 0) return null;
                  return (
                    <div key={group.path} className="mb-1.5">
                      <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-white/35">
                        <span className="truncate">{group.label ?? group.name}</span>
                        {group.owner && (
                          <span
                            title={group.originLabel ? `${OWNER_LABEL[group.owner] ?? group.owner} · ${group.originLabel}` : OWNER_LABEL[group.owner] ?? group.owner}
                            className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-normal normal-case ${OWNER_BADGE_CLASS[group.owner] ?? "bg-white/10 text-white/50"}`}
                          >
                            {OWNER_LABEL[group.owner] ?? group.owner}
                          </span>
                        )}
                        {group.owner === "user" && (
                          <span
                            data-testid="user-specs-branch-badge"
                            title={
                              userBranch
                                ? `Editable on "${userBranch}" — pick a different one in the chat's "Active feature branch" dropdown`
                                : "Pick a feature branch in the chat's \"Active feature branch\" dropdown to make this store editable"
                            }
                            className={`ml-auto shrink-0 rounded px-1 py-0.5 text-[9px] font-normal normal-case ${
                              userBranch ? "bg-emerald-500/20 text-emerald-200" : "bg-white/10 text-white/40"
                            }`}
                          >
                            {userBranch || "no branch selected"}
                          </span>
                        )}
                      </div>
                      {children.map((node) => renderNode(node, 0, isSearchingTree))}
                    </div>
                  );
                })}
              {/* Every item in the user's own user-apps/items/ (an app/ facet,
                  plus any item that already has a spec/ facet) gets its own
                  store (item-stores.ts) — one group per item, even before it
                  has a spec written and even before it's installed. Grouped
                  here under one "User Apps" heading instead of a separate
                  top-level category per item, since to the user they're all
                  just "my apps", not independent stores. */}
              {(() => {
                const itemGroups = tree.filter((group) => group.owner === "item");
                if (itemGroups.length === 0) return null;
                const rawChildren = itemGroups.flatMap((group) => group.children ?? []);
                const children = isSearchingTree ? filterTreeNodes(rawChildren, treeQuery, specByPath) : rawChildren;
                if (isSearchingTree && children.length === 0) return null;
                return (
                  <div className="mb-1.5">
                    <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-white/35">
                      <span className="truncate">User Apps</span>
                    </div>
                    {children.map((node) => renderNode(node, 0, isSearchingTree))}
                  </div>
                );
              })()}
            </>
          )}
        </div>
      </nav>

      <ResizeHandle getWidth={() => leftWidth} setWidth={setLeftWidth} min={160} max={420} />

      {/* Center: the conflict-resolution pane while a session is active (D5),
          otherwise the artifact viewer / editor. */}
      {showConflictPane ? (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <ConflictPane sessionId={conflictSessionId} onSettled={onConflictSettled} />
        </div>
      ) : (
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
        <div ref={viewerRef} onClick={onViewerClick} className={`min-h-0 flex-1 overflow-auto ${isHtmlPath && !editing ? "" : "p-5"}`}>
          {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
          {!activePath ? (
            <p className="text-xs text-white/40">Select a specification on the left to view it, or use the chat to author one.</p>
          ) : loading ? (
            <p className="text-xs text-white/40">Loading…</p>
          ) : editing ? (
            <textarea
              data-testid="build-studio-editor"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="h-full w-full resize-none rounded border border-white/10 bg-black/30 p-3 font-mono text-xs text-white/85 outline-none focus:border-white/25"
            />
          ) : isHtmlPath ? (
            <iframe
              key={loadKey}
              srcDoc={content}
              sandbox="allow-scripts"
              title={activePath}
              className="h-full w-full rounded border border-white/10 bg-[#0f1117]"
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
            ) : canEdit ? (
              <button
                onClick={() => {
                  setDraft(content);
                  setEditing(true);
                }}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-white/60 hover:bg-white/10 hover:text-white/85"
              >
                <Pencil size={12} /> Edit
              </button>
            ) : (
              <span
                title={activeGroup?.writable ? "Pick a feature branch in the chat's \"Active feature branch\" dropdown to edit this" : "Read-only"}
                className="rounded px-2 py-1 text-[10px] text-white/40"
              >
                {activeGroup?.writable ? "select a branch to edit" : "read-only"}
              </span>
            )}
          </div>
        )}
      </div>
      )}

      <ResizeHandle getWidth={() => rightWidth} setWidth={setRightWidth} min={RIGHT_MIN_W} max={rightMaxWidth} invert />

      {/* Right (resizable): the Build Studio agent chat with its own (build-studio)
          conversation list. The agent drives this app via surface tools —
          declarations ride on each run start; handlers are dispatched back to
          this mounted surface by the server run loop. */}
      <aside style={{ width: rightWidth }} className="flex shrink-0 flex-col border-l border-white/10">
        <AssistantChatV2
          // While a conflict session owns the centre, this SAME chat becomes
          // the agent↔user channel for it (FR-007a): pointing it at the
          // conflict agent makes the session's conversation the active one, so
          // the agent's decision cards and the user's answers flow here.
          agentId={showConflictPane && conflictAgentId ? conflictAgentId : buildStudioAgent}
          showConversations
          conversationsInToolbar
          initialLabel={
            showConflictPane
              ? "Answer the agent's question, or give it direction on the conflict."
              : "Describe a feature to build, or ask me to refine the selected spec."
          }
        />
      </aside>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {promptDialog && (
        <PromptDialog
          title={promptDialog.title}
          message={promptDialog.message}
          prefix={promptDialog.prefix}
          initialValue={promptDialog.initialValue}
          confirmLabel={promptDialog.confirmLabel}
          busy={dialogBusy}
          error={dialogError}
          onConfirm={promptDialog.onConfirm}
          onCancel={() => {
            setPromptDialog(null);
            setDialogError("");
          }}
        />
      )}
      {confirmDialog && (
        <ConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message + (dialogError ? `\n\n${dialogError}` : "")}
          confirmLabel={confirmDialog.confirmLabel}
          danger={confirmDialog.danger}
          busy={dialogBusy}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => {
            setConfirmDialog(null);
            setDialogError("");
          }}
        />
      )}
      {historyPath && (
        <HistoryDialog
          path={historyPath}
          onClose={() => setHistoryPath("")}
          onRestored={() => {
            loadTree();
            if (activePath === historyPath) setReloadToken((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
