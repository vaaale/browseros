"use client";

import { useCallback, useEffect, useState } from "react";
import { Markdown } from "@copilotkit/react-ui";
import "@copilotkit/react-ui/styles.css";
import { BookOpen, ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import type { AppProps } from "@/components/apps/types";

// Read-only viewer of the project documentation tree served by /api/docs:
// docs/usage/** (end users) and docs/dev/** (developers). Pick the audience with
// the switch, browse the collapsible tree, and read the rendered markdown.
type Section = "usage" | "dev";

interface DocNode {
  type: "file" | "dir";
  name: string;
  path: string;
  title: string;
  children?: DocNode[];
}

const SECTION_LABELS: Record<Section, string> = { usage: "Usage", dev: "Developer" };

function firstFile(nodes: DocNode[]): DocNode | undefined {
  for (const n of nodes) {
    if (n.type === "file") return n;
    const f = n.children && firstFile(n.children);
    if (f) return f;
  }
  return undefined;
}

export default function DocsApp(_props: AppProps) {
  const [tree, setTree] = useState<Record<Section, DocNode[]>>({ usage: [], dev: [] });
  const [section, setSection] = useState<Section>("usage");
  const [activePath, setActivePath] = useState<string>("");
  const [content, setContent] = useState<string>("");
  const [loadedKey, setLoadedKey] = useState<string>("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Load the full tree once, then select the first available page.
  useEffect(() => {
    let alive = true;
    fetch("/api/docs")
      .then((r) => r.json())
      .then((res: { tree?: Record<Section, DocNode[]> }) => {
        if (!alive) return;
        const next: Record<Section, DocNode[]> = { usage: res.tree?.usage ?? [], dev: res.tree?.dev ?? [] };
        setTree(next);
        const startUsage = firstFile(next.usage);
        const start = startUsage ?? firstFile(next.dev);
        if (start) {
          setSection(startUsage ? "usage" : "dev");
          setActivePath(start.path);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Load the active page's content whenever the selection changes. State is set
  // only inside the fetch callbacks (never synchronously in the effect body).
  useEffect(() => {
    if (!activePath) return;
    let alive = true;
    const key = `${section}/${activePath}`;
    fetch(`/api/docs?section=${encodeURIComponent(section)}&path=${encodeURIComponent(activePath)}`)
      .then((r) => r.json())
      .then((res: { doc?: { content: string } }) => {
        if (!alive) return;
        setContent(res.doc?.content ?? `Could not load "${activePath}".`);
        setLoadedKey(key);
      })
      .catch(() => {
        if (!alive) return;
        setContent(`Could not load "${activePath}".`);
        setLoadedKey(key);
      });
    return () => {
      alive = false;
    };
  }, [section, activePath]);

  const selectSection = useCallback(
    (next: Section) => {
      setSection(next);
      setActivePath(firstFile(tree[next])?.path ?? "");
    },
    [tree],
  );

  const toggleDir = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const renderNodes = (list: DocNode[], depth: number) =>
    list.map((node) => {
      const key = `${section}/${node.path}`;
      const indent = { paddingLeft: 8 + depth * 12 };
      if (node.type === "dir") {
        const isCollapsed = collapsed.has(key);
        return (
          <div key={key}>
            <button
              onClick={() => toggleDir(key)}
              style={indent}
              className="flex w-full items-center gap-1 rounded px-2 py-1 text-left text-xs font-medium text-white/55 hover:bg-white/5"
            >
              {isCollapsed ? <ChevronRight size={12} className="shrink-0" /> : <ChevronDown size={12} className="shrink-0" />}
              {isCollapsed ? <Folder size={12} className="shrink-0" /> : <FolderOpen size={12} className="shrink-0" />}
              <span className="truncate">{node.title}</span>
            </button>
            {!isCollapsed && node.children && <div>{renderNodes(node.children, depth + 1)}</div>}
          </div>
        );
      }
      const isActive = activePath === node.path;
      return (
        <button
          key={key}
          onClick={() => setActivePath(node.path)}
          style={indent}
          className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs transition-colors ${
            isActive ? "bg-white/15 text-white" : "text-white/70 hover:bg-white/10"
          }`}
        >
          <FileText size={12} className="shrink-0 opacity-60" />
          <span className="truncate">{node.title}</span>
        </button>
      );
    });

  const activeKey = activePath ? `${section}/${activePath}` : "";
  const loading = Boolean(activePath) && loadedKey !== activeKey;
  const nodes = tree[section] ?? [];

  return (
    <div className="flex h-full text-sm" data-theme="dark">
      <nav className="flex w-56 shrink-0 flex-col overflow-hidden border-r border-white/10 bg-white/[0.02]">
        <div className="flex items-center gap-1.5 px-3 pt-2 text-xs font-semibold uppercase tracking-wide text-white/40">
          <BookOpen size={13} /> Documentation
        </div>
        <div className="flex gap-1 px-2 py-2">
          {(["usage", "dev"] as Section[]).map((s) => (
            <button
              key={s}
              onClick={() => selectSection(s)}
              className={`flex-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
                section === s ? "bg-white/15 text-white" : "text-white/55 hover:bg-white/10"
              }`}
            >
              {SECTION_LABELS[s]}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
          {nodes.length > 0 ? (
            renderNodes(nodes, 0)
          ) : (
            <p className="px-3 py-2 text-xs text-white/40">No documents.</p>
          )}
        </div>
      </nav>
      <div className="min-w-0 flex-1 overflow-auto p-5">
        {loading ? (
          <p className="text-xs text-white/40">Loading…</p>
        ) : activePath && content ? (
          <article className="prose-sm max-w-none text-white/85">
            <Markdown content={content} />
          </article>
        ) : (
          <p className="text-xs text-white/40">Select a document.</p>
        )}
      </div>
    </div>
  );
}
