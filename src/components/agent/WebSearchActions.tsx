"use client";

import { useCopilotAction } from "@copilotkit/react-core";

// A client tool handler that never settles is fatal: CopilotKit executes a
// message's tool calls sequentially (await per call), so one hung fetch stalls
// the whole tool loop forever — no result, no follow-up run, the chat dies.
// These handlers therefore MUST always resolve; a timeout returns an error
// string, which CopilotKit records as the tool result so the run continues.
const WEB_TOOL_TIMEOUT_MS = 110_000;

async function postJsonWithTimeout(
  url: string,
  body: unknown,
): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_TOOL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { ok: true, json: await res.json() };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return {
      ok: false,
      error:
        e?.name === "AbortError"
          ? `timed out after ${WEB_TOOL_TIMEOUT_MS / 1000}s`
          : e?.message || "request failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

export function WebSearchActions({ webSearchAvailable }: { webSearchAvailable: boolean }) {
  useCopilotAction({
    name: "web_search",
    available: webSearchAvailable ? undefined : "disabled",
    description:
      "Search the web with Anthropic native web search. Use for current facts, recent events, or source-backed answers. Always cite source URLs from the results.",
    parameters: [
      { name: "query", type: "string", description: "Search query, 2-1000 characters.", required: true },
      { name: "allowed_domains", type: "string[]", description: "Optional domain allowlist, e.g. ['example.com']. Do not combine with blocked_domains.", required: false },
      { name: "blocked_domains", type: "string[]", description: "Optional domain blocklist, e.g. ['example.com']. Do not combine with allowed_domains.", required: false },
    ],
    handler: async ({ query, allowed_domains, blocked_domains }) => {
      const out = await postJsonWithTimeout("/api/web-search", { query, allowed_domains, blocked_domains });
      if (!out.ok) return `Error: web search ${out.error}`;
      const res = out.json as { result?: { query: string; text: string; hits: { title: string; url: string; page_age?: string }[] }; error?: string };
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
  });

  useCopilotAction({
    name: "web_fetch",
    description: "Fetch a specific URL and return its readable text content. Use for a single known URL when web_search's summaries are not enough.",
    parameters: [
      { name: "url", type: "string", description: "Absolute URL to fetch (http/https).", required: true },
    ],
    handler: async ({ url }) => {
      const out = await postJsonWithTimeout("/api/web-fetch", { url });
      if (!out.ok) return `Error: web fetch ${out.error}`;
      const res = out.json as { result?: string; error?: string };
      if (res.error) return `Error: ${res.error}`;
      return String(res.result ?? "");
    },
  });

  return null;
}
