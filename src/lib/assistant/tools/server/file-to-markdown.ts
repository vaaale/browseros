import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, parallel, schema, p } from "./util";
import { runCommand } from "@/lib/system/run-command";
import { readText, remove } from "@/os/vfs";
import { isWritableVfsPath, writeFetched } from "./web-search";

// Mechanical PDF/DOCX/PPTX/XLSX -> markdown conversion (040-okf-knowledge-base
// ingestion redesign). Wraps the sandbox's existing `markitdown` install via
// run_command's plumbing directly — never exposes free-text `command` to the
// model, so this stays safe to grant to a least-privilege sub-agent (e.g. the
// OKF item's bundled ingest agent) that must not get full run_command access.
// Only /workspace is visible in the run_command sandbox; source files must
// already live there, and the converted output never needs KnowledgeBase/ (or
// any other app's storage) to be mounted into the sandbox at all.

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Reject anything outside /workspace or containing a `..` traversal segment. */
function validateWorkspacePath(vfsPath: string): string | null {
  const normalized = vfsPath.trim();
  if (normalized !== "/workspace" && !normalized.startsWith("/workspace/")) return null;
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

export function fileToMarkdownTools(): Record<string, AssistantTool> {
  return {
    // Parallel-safe: the sandbox container is now single-flighted per session
    // (run-command.ts), each call writes a uniquely-named temp output it alone
    // reads and deletes, and markitdown's Office/PDF path is pure Python (no
    // shared LibreOffice profile to contend over). Converting a batch of
    // documents at once is the common case, so this is worth having.
    file_to_markdown: parallel(serverTool(
      "file_to_markdown",
      "Convert a PDF/DOCX/PPTX/XLSX file already under /workspace to clean markdown, via the sandbox's markitdown install (Settings → Command Execution must be enabled). Returns the converted markdown text directly.\n\n" +
        "Set output_path when you do not need to READ the document yourself — e.g. handing it to another tool. The markdown is written to that VFS path and only a short confirmation comes back, so a long document never enters your context and you never have to retype it to store it.",
      schema(
        {
          path: p.str("VFS path under /workspace to the source file, e.g. /workspace/report.pdf."),
          output_path: p.str(
            "Optional VFS path to write the markdown to (e.g. /workspace/report.md). When set, the content is NOT returned — you get a confirmation with the path and size instead.",
          ),
        },
        ["path"],
      ),
      async (input, ctx) => {
        const raw = String(input.path ?? "").trim();
        if (!raw) return "Error: file_to_markdown: path is required.";
        const safePath = validateWorkspacePath(raw);
        if (!safePath) return "Error: file_to_markdown: path must be a /workspace/... path with no '..' segments.";
        const outputPath = String(input.output_path ?? "").trim();
        if (outputPath && !isWritableVfsPath(outputPath)) {
          return "Error: file_to_markdown: output_path must be an absolute VFS path with no '..' segments (e.g. /workspace/report.md).";
        }

        const outPath = `/workspace/.file-to-markdown-${Date.now()}-${Math.random().toString(36).slice(2)}.md`;
        const command = `markitdown ${shellQuote(safePath)} -o ${shellQuote(outPath)}`;
        const result = await runCommand({ command, sessionKey: `${ctx.conversationId}:${ctx.agentId}` });
        if (!result.ok) {
          return `Error: file_to_markdown: conversion failed (exit ${result.exitCode ?? "?"}): ${result.output}`;
        }
        try {
          const markdown = await readText(outPath);
          return outputPath ? await writeFetched(outputPath, safePath, markdown) : markdown;
        } catch (err) {
          return `Error: file_to_markdown: markitdown reported success but produced no output file: ${err instanceof Error ? err.message : String(err)}`;
        } finally {
          // The scratch file is always cleaned up — output_path is written
          // explicitly above, so a caller's destination is never the temp file.
          await remove(outPath).catch(() => {});
        }
      },
    )),
  };
}
