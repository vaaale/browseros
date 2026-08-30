import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, parallel, schema, p } from "./util";
import { webSearch, isNativeWebSearchAvailable, webFetch, isNativeWebFetchAvailable, type WebSearchInput } from "@/lib/agent/web-search";
import { fetchText } from "@/lib/net";
import * as vfs from "@/os/vfs";

// Web tools (ported from WebSearchActions.tsx): native provider web search and
// a readable-text URL fetch. The old client computed `webSearchAvailable` from
// /api/agent/provider and disabled the action; server-side the same check runs
// per call and unavailability is reported in-band.

/**
 * `output_path` — write the fetched content straight to the VFS and return only
 * a receipt (040-okf-knowledge-base FR-024).
 *
 * This is what makes "ingest a URL without the document passing through the
 * model" actually possible. Without it, every acquisition tool returns content
 * as a tool-result string, so the ONLY way to persist it is for the model to
 * re-emit the whole document as output tokens — the exact cost the ingest
 * redesign exists to avoid. With a path, downstream tools (okf_add_raw_source's
 * `sourcePath`, file_read, …) reference the bytes instead of re-transcribing
 * them.
 */
export function isWritableVfsPath(p: string): boolean {
  return p.startsWith("/") && !p.split("/").includes("..");
}

export async function writeFetched(outputPath: string, url: string, content: string): Promise<string> {
  await vfs.writeText(outputPath, content);
  return (
    `Fetched ${url} → wrote ${content.length} characters to ${outputPath}. ` +
    `The content is deliberately NOT included here. Reference it by path (e.g. pass it as sourcePath, ` +
    `or file_read it) rather than asking for it again.`
  );
}

export function webSearchTools(): Record<string, AssistantTool> {
  return {
    // Both are stateless network reads against the provider API — safe to run
    // several at once, and the case where concurrency pays off most (a turn
    // that fans out across several sources).
    web_search: parallel(serverTool(
      "web_search",
      "Search the web with Anthropic native web search. Use for current facts, recent events, or source-backed answers. Always cite source URLs from the results.",
      schema(
        {
          query: p.str("Search query, 2-1000 characters."),
          allowed_domains: p.strArr("Optional domain allowlist, e.g. ['example.com']. Do not combine with blocked_domains."),
          blocked_domains: p.strArr("Optional domain blocklist, e.g. ['example.com']. Do not combine with allowed_domains."),
        },
        ["query"],
      ),
      async (input, ctx) => {
        if (!(await isNativeWebSearchAvailable())) {
          return "Error: web_search: not available for the current provider — native web search needs an Anthropic or OpenAI provider with an API key (Settings → AI Provider). Answer from your own knowledge or ask the user to switch providers.";
        }
        const result = await webSearch(input as unknown as WebSearchInput, ctx.runId);
        const lines = [`Web search results for: ${result.query}`];
        if (result.text) lines.push("", result.text);
        if (result.hits.length) {
          lines.push("", "Sources:");
          result.hits.forEach((hit, index) => {
            lines.push(`${index + 1}. ${hit.title || hit.url} - ${hit.url}${hit.page_age ? ` (${hit.page_age})` : ""}`);
          });
        }
        lines.push("", "When answering, cite the relevant source URLs explicitly.");
        return lines.join("\n");
      },
    )),

    web_fetch: parallel(serverTool(
      "web_fetch",
      "Fetch a specific URL and return its readable content as markdown, with links preserved. Use for a single known URL when web_search's summaries are not enough.\n\n" +
        "Set output_path when you do not need to READ the page yourself — e.g. archiving it, or handing it to another tool. The content is written straight to that VFS path and only a short confirmation comes back, so a long document never enters your context and you never have to retype it to store it.",
      schema(
        {
          url: p.str("Absolute URL to fetch (http/https)."),
          output_path: p.str(
            "Optional VFS path to write the content to (e.g. /workspace/article.md). When set, the content is NOT returned — you get a confirmation with the path and size instead.",
          ),
        },
        ["url"],
      ),
      async (input, ctx) => {
        const url = String(input.url ?? "").trim();
        if (!url) return "Error: web_fetch: url is required — provide an absolute http(s) URL.";
        const outputPath = String(input.output_path ?? "").trim();
        if (outputPath && !isWritableVfsPath(outputPath)) {
          return "Error: web_fetch: output_path must be an absolute VFS path with no '..' segments (e.g. /workspace/article.md).";
        }
        const deliver = (content: string) => (outputPath ? writeFetched(outputPath, url, content) : content);

        // Prefer the provider's own web-fetch server tool where one exists
        // (Anthropic): it does the extraction upstream and returns cleaner
        // output than any local converter. Everywhere else — a self-hosted or
        // OpenAI-compatible endpoint — fetch and convert locally rather than
        // failing. This tool worked on every provider before native support
        // was added, and taking that away from non-Anthropic users would be a
        // straight downgrade for them.
        if (await isNativeWebFetchAvailable()) {
          try {
            return await deliver((await webFetch(url, ctx.runId)).content);
          } catch (err) {
            // The native tool can decline for reasons the local path doesn't
            // share (most often: the URL never appeared earlier in the
            // conversation, which it requires). Fall through rather than
            // surface a provider-specific rule as a dead end.
            const detail = err instanceof Error ? err.message : String(err);
            try {
              return await deliver(await fetchText(url));
            } catch (fallbackErr) {
              const fallbackDetail = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
              return `Error: web_fetch: ${detail} (direct fetch also failed: ${fallbackDetail})`;
            }
          }
        }

        try {
          return await deliver(await fetchText(url));
        } catch (err) {
          return `Error: web_fetch: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    )),
  };
}
