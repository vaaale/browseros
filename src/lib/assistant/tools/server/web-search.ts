import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { webSearch, isNativeWebSearchAvailable, type WebSearchInput } from "@/lib/agent/web-search";
import { fetchText } from "@/lib/net";

// Web tools (ported from WebSearchActions.tsx): native provider web search and
// a readable-text URL fetch. The old client computed `webSearchAvailable` from
// /api/agent/provider and disabled the action; server-side the same check runs
// per call and unavailability is reported in-band.

export function webSearchTools(): Record<string, AssistantTool> {
  return {
    web_search: serverTool(
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
    ),

    web_fetch: serverTool(
      "web_fetch",
      "Fetch a specific URL and return its readable text content. Use for a single known URL when web_search's summaries are not enough.",
      schema({ url: p.str("Absolute URL to fetch (http/https).") }, ["url"]),
      async (input) => {
        const url = String(input.url ?? "").trim();
        if (!url) return "Error: web_fetch: url is required — provide an absolute http(s) URL.";
        return String(await fetchText(url));
      },
    ),
  };
}
