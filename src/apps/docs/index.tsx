"use client";

import { useCallback, useEffect, useState } from "react";
import { Markdown } from "@copilotkit/react-ui";
import "@copilotkit/react-ui/styles.css";
import { BookOpen } from "lucide-react";
import type { AppProps } from "@/components/apps/types";

interface Doc {
  id: string;
  title: string;
  content: string;
}

export default function DocsApp(_props: AppProps) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [active, setActive] = useState<string>("");

  const load = useCallback(async () => {
    const res = await fetch("/api/docs").then((r) => r.json());
    const list: Doc[] = res.docs ?? [];
    setDocs(list);
    setActive((cur) => cur || list[0]?.id || "");
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const current = docs.find((d) => d.id === active);

  return (
    <div className="flex h-full text-sm" data-theme="dark">
      <nav className="w-48 shrink-0 overflow-auto border-r border-white/10 bg-white/[0.02] p-2">
        <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-white/40">
          <BookOpen size={13} /> Docs
        </div>
        {docs.map((d) => (
          <button
            key={d.id}
            onClick={() => setActive(d.id)}
            className={`mt-0.5 block w-full truncate rounded px-2 py-1.5 text-left text-xs transition-colors ${
              active === d.id ? "bg-white/15 text-white" : "text-white/70 hover:bg-white/10"
            }`}
          >
            {d.title}
          </button>
        ))}
        {docs.length === 0 && <p className="px-2 py-2 text-xs text-white/40">No docs yet.</p>}
      </nav>
      <div className="min-w-0 flex-1 overflow-auto p-5">
        {current ? (
          <article className="prose-sm max-w-none text-white/85">
            <Markdown content={current.content} />
          </article>
        ) : (
          <p className="text-xs text-white/40">Select a document.</p>
        )}
      </div>
    </div>
  );
}
