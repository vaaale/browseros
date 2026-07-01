import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { getProviderConfig, DEFAULT_MAX_TOKENS } from "@/lib/agent/provider";
import { familyOf } from "@/lib/agent/provider-meta";

export interface WebSearchInput {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

export interface WebSearchHit {
  title: string;
  url: string;
  page_age?: string;
  encrypted_content?: string;
}

export interface WebSearchResultBlock {
  type: "web_search_tool_result" | "server_tool_use" | "text";
  content: unknown;
}

export interface WebSearchOutput {
  query: string;
  hits: WebSearchHit[];
  text: string;
  blocks: WebSearchResultBlock[];
}

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 1000;
const MAX_DOMAINS = 20;
const MAX_DOMAIN_LENGTH = 253;

export function validateWebSearchInput(input: unknown): WebSearchInput {
  if (!input || typeof input !== "object") throw new Error("Request body must be a JSON object.");
  const raw = input as Record<string, unknown>;
  if (typeof raw.query !== "string") throw new Error("'query' is required and must be a string.");

  const query = raw.query.trim();
  if (query.length < MIN_QUERY_LENGTH) throw new Error("'query' must be at least 2 characters long.");
  if (query.length > MAX_QUERY_LENGTH) throw new Error("'query' must be 1000 characters or fewer.");

  const allowed_domains = validateDomains(raw.allowed_domains, "allowed_domains");
  const blocked_domains = validateDomains(raw.blocked_domains, "blocked_domains");
  if (allowed_domains && blocked_domains) {
    throw new Error("Use either 'allowed_domains' or 'blocked_domains', not both.");
  }

  return { query, ...(allowed_domains ? { allowed_domains } : {}), ...(blocked_domains ? { blocked_domains } : {}) };
}

export async function isNativeWebSearchAvailable(): Promise<boolean> {
  const config = await getProviderConfig();
  return familyOf(config.provider) === "anthropic" && !!config.apiKey;
}

export async function webSearch(input: WebSearchInput): Promise<WebSearchOutput> {
  const valid = validateWebSearchInput(input);
  const config = await getProviderConfig();
  if (familyOf(config.provider) !== "anthropic") {
    throw new Error("Native web search is currently available only with the Anthropic provider.");
  }
  if (!config.apiKey) throw new Error("Anthropic API key is required for native web search.");

  const client = new Anthropic({ apiKey: config.apiKey, baseURL: config.baseUrl || undefined });
  const res = await client.beta.messages.create({
    model: config.model,
    max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: [{ role: "user", content: valid.query }],
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        ...(valid.allowed_domains ? { allowed_domains: valid.allowed_domains } : {}),
        ...(valid.blocked_domains ? { blocked_domains: valid.blocked_domains } : {}),
      },
    ],
  } as Parameters<typeof client.beta.messages.create>[0]) as { content: unknown[] };

  const blocks: WebSearchResultBlock[] = [];
  const hits: WebSearchHit[] = [];
  const text: string[] = [];

  for (const block of res.content as unknown[]) {
    const typed = block as Record<string, unknown>;
    if (typed.type === "text") {
      blocks.push({ type: "text", content: typed });
      if (typeof typed.text === "string") text.push(typed.text);
      continue;
    }
    if (typed.type === "server_tool_use") {
      blocks.push({ type: "server_tool_use", content: typed });
      continue;
    }
    if (typed.type === "web_search_tool_result") {
      blocks.push({ type: "web_search_tool_result", content: typed });
      for (const hit of extractHits(typed.content)) hits.push(hit);
    }
  }

  return { query: valid.query, hits: dedupeHits(hits), text: text.join("\n").trim(), blocks };
}

export function formatWebSearchForModel(output: WebSearchOutput): string {
  const lines = [`Web search results for: ${output.query}`];
  if (output.text) lines.push("", output.text);
  if (output.hits.length) {
    lines.push("", "Sources:");
    output.hits.forEach((hit, index) => {
      lines.push(`${index + 1}. ${hit.title || hit.url} - ${hit.url}${hit.page_age ? ` (${hit.page_age})` : ""}`);
    });
  }
  lines.push("", "When using these results, cite the source URLs explicitly.");
  return lines.join("\n");
}

function validateDomains(value: unknown, name: "allowed_domains" | "blocked_domains"): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`'${name}' must be an array of domain strings.`);
  if (value.length > MAX_DOMAINS) throw new Error(`'${name}' may include at most 20 domains.`);
  const domains = value.map((domain, index) => {
    if (typeof domain !== "string") throw new Error(`'${name}[${index}]' must be a string.`);
    const normalized = domain.trim().toLowerCase();
    if (!normalized) throw new Error(`'${name}[${index}]' must not be empty.`);
    if (normalized.length > MAX_DOMAIN_LENGTH) throw new Error(`'${name}[${index}]' must be 253 characters or fewer.`);
    if (normalized.includes("/") || normalized.includes(":")) {
      throw new Error(`'${name}[${index}]' must be a domain, not a URL.`);
    }
    return normalized;
  });
  return domains.length ? Array.from(new Set(domains)) : undefined;
}

function extractHits(content: unknown): WebSearchHit[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const raw = entry as Record<string, unknown>;
    if (raw.type !== "web_search_result") return [];
    if (typeof raw.url !== "string") return [];
    return [{
      title: typeof raw.title === "string" ? raw.title : raw.url,
      url: raw.url,
      ...(typeof raw.page_age === "string" ? { page_age: raw.page_age } : {}),
      ...(typeof raw.encrypted_content === "string" ? { encrypted_content: raw.encrypted_content } : {}),
    }];
  });
}

function dedupeHits(hits: WebSearchHit[]): WebSearchHit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    if (seen.has(hit.url)) return false;
    seen.add(hit.url);
    return true;
  });
}
