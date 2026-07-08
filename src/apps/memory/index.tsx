"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Brain,
  User,
  FileText,
  BookOpen,
  Settings,
  Search,
  Clock,
  CheckCircle,
  Folder,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import ProfileTab from "./components/ProfileTab";
import EpisodesTab from "./components/EpisodesTab";
import TopicsTab from "./components/TopicsTab";
import LoopsTab from "./components/LoopsTab";
import SearchTab from "./components/SearchTab";

type TabId = "profile" | "episodes" | "topics" | "loops" | "search";

interface TabDef {
  id: TabId;
  label: string;
  icon: LucideIcon;
}

const TABS: TabDef[] = [
  { id: "profile", label: "Profile & Notes", icon: User },
  { id: "episodes", label: "Episodes", icon: FileText },
  { id: "topics", label: "Topics", icon: BookOpen },
  { id: "loops", label: "Memory Loops", icon: Settings },
  { id: "search", label: "Search", icon: Search },
];

interface Stats {
  pending: number;
  consolidated: number;
  topics: number;
}

export default function MemoryApp() {
  const [active, setActive] = useState<TabId>("profile");
  const [stats, setStats] = useState<Stats>({ pending: 0, consolidated: 0, topics: 0 });

  const loadStats = useCallback(async () => {
    try {
      const [epRes, topicsRes] = await Promise.all([
        fetch("/api/memory/episodes"),
        fetch("/api/memory/topics"),
      ]);
      const next: Stats = { pending: 0, consolidated: 0, topics: 0 };
      if (epRes.ok) {
        const data = (await epRes.json()) as { pending?: unknown[]; consolidated?: unknown[] };
        next.pending = Array.isArray(data.pending) ? data.pending.length : 0;
        next.consolidated = Array.isArray(data.consolidated) ? data.consolidated.length : 0;
      }
      if (topicsRes.ok) {
        const data = (await topicsRes.json()) as { topics?: unknown[] };
        next.topics = Array.isArray(data.topics) ? data.topics.length : 0;
      }
      setStats(next);
    } catch {
      // Stats are best-effort — leave defaults on failure.
    }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => void loadStats(), 0);
    return () => clearTimeout(id);
  }, [loadStats]);

  const ActiveTab =
    active === "profile"
      ? ProfileTab
      : active === "episodes"
        ? EpisodesTab
        : active === "topics"
          ? TopicsTab
          : active === "loops"
            ? LoopsTab
            : SearchTab;

  return (
    <div className="flex h-full flex-col text-xs">
      <header className="flex shrink-0 items-center justify-between border-b border-white/10 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Brain className="h-5 w-5 text-violet-300" />
          <h1 className="text-sm font-semibold">Memory</h1>
        </div>
        <div className="flex items-center gap-2">
          <StatBadge
            icon={Clock}
            label={`${stats.pending} Pending`}
            accent="border-l-amber-400"
          />
          <StatBadge
            icon={CheckCircle}
            label={`${stats.consolidated} Consolidated`}
            accent="border-l-emerald-400"
          />
          <StatBadge
            icon={Folder}
            label={`${stats.topics} Topics`}
            accent="border-l-white/10"
          />
        </div>
      </header>

      <nav className="shrink-0 border-b border-white/10 px-3 py-2">
        <div className="flex gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-1">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = tab.id === active;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActive(tab.id)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  isActive
                    ? "bg-white/15 text-white"
                    : "text-white/70 hover:bg-white/10 hover:text-white"
                }`}
                aria-pressed={isActive}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <main className="min-h-0 flex-1 overflow-auto p-3">
        <ActiveTab />
      </main>
    </div>
  );
}

function StatBadge({
  icon: Icon,
  label,
  accent,
}: {
  icon: LucideIcon;
  label: string;
  accent: string;
}) {
  return (
    <div
      className={`flex items-center gap-1.5 rounded-md border-l-2 bg-white/[0.05] px-2.5 py-1 text-[11px] text-white/80 ${accent}`}
    >
      <Icon className="h-3 w-3" />
      <span>{label}</span>
    </div>
  );
}
