"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FileText, FolderTree, Hammer, RefreshCw } from "lucide-react";
import type { AppProps } from "@/components/apps/types";
import type { Specification, SpecTreeNode } from "@/lib/specs/types";
import { AssistantChat } from "@/components/agent/AssistantChat";

// Build Studio (013-build-studio-agentic): a spec tree for context/visualization
// plus the embedded assistant pinned to the Build Studio agent + its own
// conversation group. The agent does the authoring (and delegates the build to
// the Developer); the tree mirrors specs/.
export default function BuildStudioApp(_props: AppProps) {
  const [tree, setTree] = useState<SpecTreeNode[]>([]);
  const [specs, setSpecs] = useState<Specification[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const loadTree = () => {
    fetch("/api/specs")
      .then((r) => r.json())
      .then((res: { tree?: SpecTreeNode[]; specs?: Specification[] }) => {
        setTree(res.tree ?? []);
        setSpecs(res.specs ?? []);
      })
      .catch(() => {});
  };

  useEffect(() => {
    loadTree();
  }, []);

  const specById = new Map(specs.map((s) => [s.id, s]));
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="flex h-full text-sm" data-theme="dark">
      <nav className="flex w-56 shrink-0 flex-col overflow-hidden border-r border-white/10 bg-white/[0.02]">
        <div className="flex items-center justify-between px-3 pt-2 text-xs font-semibold uppercase tracking-wide text-white/40">
          <span className="flex items-center gap-1.5">
            <Hammer size={13} /> Build Studio
          </span>
          <button onClick={loadTree} title="Refresh" className="rounded p-1 text-white/40 hover:bg-white/10 hover:text-white/70">
            <RefreshCw size={12} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-1 py-2">
          {tree.length === 0 ? (
            <p className="px-3 py-2 text-xs text-white/40">No specs yet. Describe a feature in the chat and Build Studio will create one.</p>
          ) : (
            tree.map((node) =>
              node.type === "feature" ? (
                <div key={node.path}>
                  <button
                    onClick={() => toggle(node.path)}
                    className="flex w-full items-center gap-1 rounded px-2 py-1 text-left text-xs font-medium text-white/70 hover:bg-white/5"
                  >
                    {collapsed.has(node.path) ? <ChevronRight size={12} className="shrink-0" /> : <ChevronDown size={12} className="shrink-0" />}
                    <FolderTree size={12} className="shrink-0 opacity-60" />
                    <span className="truncate">{specById.get(node.name)?.title ?? node.name}</span>
                  </button>
                  {!collapsed.has(node.path) &&
                    node.children?.map((child) => (
                      <div key={child.path} style={{ paddingLeft: 30 }} className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-white/55">
                        <FileText size={12} className="shrink-0 opacity-60" />
                        <span className="truncate">{child.name}</span>
                      </div>
                    ))}
                </div>
              ) : (
                <div key={node.path} className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-white/55">
                  <FileText size={12} className="shrink-0 opacity-60" />
                  <span className="truncate">{node.name}</span>
                </div>
              ),
            )
          )}
        </div>
      </nav>

      <div className="min-w-0 flex-1">
        <AssistantChat
          agentId="build-studio"
          group="build-studio"
          showConversations
          showInfo={false}
          initialLabel="Describe a feature to build, or ask me to refine a spec."
        />
      </div>
    </div>
  );
}
