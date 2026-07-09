"use client";

import { useState, type ReactNode } from "react";
// react-syntax-highlighter ships no types (transitive dep of @copilotkit); the
// project's tsconfig `include` doesn't cover a standalone .d.ts, so suppress the
// untyped-import errors here. The runtime module resolves fine.
// @ts-expect-error - no bundled type declarations
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
// @ts-expect-error - no bundled type declarations
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Check, Copy } from "lucide-react";
import type { ComponentsMap } from "@copilotkit/react-ui";

// Renders an ```html fenced block as code plus a sandboxed live preview.
function HtmlBlock({ code }: { code: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="my-1.5 overflow-hidden rounded-md border border-white/10">
      <div className="flex items-center justify-between bg-white/5 px-2 py-1 text-[11px] text-white/50">
        <span>html</span>
        <button onClick={() => setShow((s) => !s)} className="rounded px-1.5 hover:bg-white/10">
          {show ? "Hide preview" : "Preview"}
        </button>
      </div>
      <SyntaxHighlighter {...highlighterProps("markup")}>{code}</SyntaxHighlighter>
      {show && (
        <iframe srcDoc={code} sandbox="allow-scripts" className="h-64 w-full border-0 bg-white" title="HTML preview" />
      )}
    </div>
  );
}

// Shared props for the Prism highlighter. The theme (oneDark) applies token
// colors inline (no CSS import needed). Font family + size come from the chat's
// CSS variables so they follow the Settings → Appearance choice.
function highlighterProps(language: string) {
  const codeFont = "var(--bos-chat-code-font, var(--font-geist-mono), ui-monospace, monospace)";
  const codeSize = "var(--bos-chat-code-font-size, 13px)";
  return {
    language,
    style: oneDark,
    PreTag: "div" as const,
    customStyle: {
      margin: 0,
      background: "transparent",
      padding: "0.6rem 0.75rem",
      fontSize: codeSize,
    },
    codeTagProps: { style: { fontFamily: codeFont, fontSize: codeSize } },
  };
}

// Prism uses "markup" for html/xml; map a few friendly aliases.
function normalizeLang(lang?: string): string {
  if (!lang) return "text";
  const l = lang.toLowerCase();
  if (l === "html" || l === "xml" || l === "svg") return "markup";
  if (l === "sh" || l === "shell" || l === "zsh") return "bash";
  if (l === "yml") return "yaml";
  return l;
}

function CodeBlock({ language, code }: { language?: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => undefined,
    );
  };
  return (
    <div className="my-1.5 overflow-hidden rounded-md border border-white/10 bg-black/40">
      <div className="flex items-center justify-between bg-white/5 px-2 py-1 text-[11px] text-white/50">
        <span>{language || "code"}</span>
        <button onClick={copy} className="flex items-center gap-1 rounded px-1.5 hover:bg-white/10 hover:text-white/80">
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="overflow-x-auto">
        <SyntaxHighlighter {...highlighterProps(normalizeLang(language))}>{code}</SyntaxHighlighter>
      </div>
    </div>
  );
}

// Markdown component overrides for the chat. Fenced code blocks are syntax-
// highlighted (Prism + oneDark); HTML blocks also get a sandboxed live preview;
// inline code keeps the default styling. Font family/size follow the chat's
// CSS variables set from Settings → Appearance.
export const markdownRenderers: ComponentsMap = {
  code: (({ className, children }: { className?: string; children?: ReactNode }) => {
    const lang = /language-(\w+)/.exec(className || "")?.[1];
    const text = String(children ?? "").replace(/\n$/, "");
    // Inline code (no language + single line) keeps CopilotKit's default look.
    const isBlock = !!lang || text.includes("\n");
    if (!isBlock) return <code className={className}>{children}</code>;
    if (lang === "html" && /<\w/.test(text)) return <HtmlBlock code={text} />;
    return <CodeBlock language={lang} code={text} />;
  }) as ComponentsMap[string],
};
