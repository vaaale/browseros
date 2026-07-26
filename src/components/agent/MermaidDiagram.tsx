"use client";

import { useEffect, useId, useRef } from "react";

export function MermaidDiagram({ code }: { code: string }) {
  const rawId = useId();
  const id = `mermaid-${rawId.replace(/:/g, "")}`;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    import("mermaid").then(({ default: mermaid }) => {
      if (cancelled || !ref.current) return;
      mermaid.initialize({ startOnLoad: false, theme: "dark" });
      mermaid
        .render(id, code)
        .then(({ svg }) => {
          if (cancelled || !ref.current) return;
          ref.current.innerHTML = svg;
        })
        .catch(() => {
          if (cancelled || !ref.current) return;
          ref.current.textContent = code;
        });
    });
    return () => {
      cancelled = true;
    };
  }, [code, id]);

  return <div ref={ref} className="my-4 flex justify-center overflow-x-auto" />;
}
