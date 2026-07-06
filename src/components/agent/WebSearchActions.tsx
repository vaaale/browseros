"use client";

import { useState, useEffect } from "react";
import { useCopilotAction } from "@/components/agent/gated-action";

export function WebSearchActions() {
  const [nativeSearchAvailable, setNativeSearchAvailable] = useState(false);

  useEffect(() => {
    fetch("/api/agent/provider")
      .then((r) => r.json())
      .then((d: { provider?: string; hasApiKey?: boolean }) => {
        setNativeSearchAvailable(d.provider === "anthropic" && !!d.hasApiKey);
      })
      .catch(() => {});
  }, []);

  useCopilotAction({
    name: "web_search",
    available: nativeSearchAvailable ? undefined : "disabled",
    description:
      "Search the web with Anthropic native web search. Use for current facts, recent events, or source-backed answers. Always cite source URLs from the results.",
    parameters: [
      { name: "query", type: "string", description: "Search query, 2-1000 characters.", required: true },
      { name: "allowed_domains", type: "string[]", description: "Optional domain allowlist, e.g. ['example.com']. Do not combine with blocked_domains.", required: false },
      { name: "blocked_domains", type: "string[]", description: "Optional domain blocklist, e.g. ['example.com']. Do not combine with allowed_domains.", required: false },
    ],
    handler: async ({ query, allowed_domains, blocked_domains }) => {
      const res = await fetch("/api/web-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, allowed_domains, blocked_domains }),
      }).then((r) => r.json()) as { result?: { query: string; text: string; hits: { title: string; url: string; page_age?: string }[] }; error?: string };
      if (res.error) return `Error: ${res.error}`;
      if (!res.result) return "Error: Web search returned no result.";

      const lines = [`Web search results for: ${res.result.query}`];
      if (res.result.text) lines.push("", res.result.text);
      if (res.result.hits.length) {
        lines.push("", "Sources:");
        res.result.hits.forEach((hit, index) => {
          lines.push(`${index + 1}. ${hit.title || hit.url} - ${hit.url}${hit.page_age ? ` (${hit.page_age})` : ""}`);
        });
      }
      lines.push("", "When answering, cite the relevant source URLs explicitly.");
      return lines.join("\n");
    },
  }, [nativeSearchAvailable]);

  useCopilotAction({
    name: "web_fetch",
    description: "Fetch a specific URL and return its readable text content. Use for a single known URL when web_search's summaries are not enough.",
    parameters: [
      { name: "url", type: "string", description: "Absolute URL to fetch (http/https).", required: true },
    ],
    handler: async ({ url }) => {
      const res = await fetch("/api/web-fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      }).then((r) => r.json()) as { result?: string; error?: string };
      if (res.error) return `Error: ${res.error}`;
      return String(res.result ?? "");
    },
  });

  return null;
}
