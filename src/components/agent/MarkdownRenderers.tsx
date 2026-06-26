"use client";

import { useState, type ReactNode } from "react";
import type { ComponentsMap } from "@copilotkit/react-ui";

// Renders an ```html fenced block as code plus a sandboxed live preview.
function HtmlBlock({ code }: { code: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="my-1 overflow-hidden rounded-md border border-white/10">
      <div className="flex items-center justify-between bg-white/5 px-2 py-1 text-[11px] text-white/50">
        <span>html</span>
        <button onClick={() => setShow((s) => !s)} className="rounded px-1.5 hover:bg-white/10">
          {show ? "Hide preview" : "Preview"}
        </button>
      </div>
      <pre className="overflow-x-auto p-2 text-[11px] text-white/70">
        <code>{code}</code>
      </pre>
      {show && (
        <iframe srcDoc={code} sandbox="allow-scripts" className="h-64 w-full border-0 bg-white" title="HTML preview" />
      )}
    </div>
  );
}

// Markdown component overrides for the chat: HTML code blocks get a live
// preview; everything else (markdown, inline code, other languages) renders
// with the default styling.
export const markdownRenderers: ComponentsMap = {
  code: (({ className, children }: { className?: string; children?: ReactNode }) => {
    const lang = /language-(\w+)/.exec(className || "")?.[1];
    const text = String(children ?? "");
    if (lang === "html" && /<\w/.test(text)) return <HtmlBlock code={text} />;
    return <code className={className}>{children}</code>;
  }) as ComponentsMap[string],
};
