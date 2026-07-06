import { NextRequest, NextResponse } from "next/server";
import { getProviderConfig } from "@/lib/agent/provider";
import { familyOf, normalizeApiBase, PROVIDERS } from "@/lib/agent/provider-meta";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com";
const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";
const FETCH_TIMEOUT_MS = 10_000;

// Builds the /models endpoint URL, tolerating both base URLs that already
// include /v1 (e.g. https://api.openai.com/v1) and ones that don't.
function modelsUrl(rawBase: string): string {
  const base = normalizeApiBase(rawBase);
  if (/\/v\d+$/.test(base)) return `${base}/models`;
  return `${base}/v1/models`;
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, cache: "no-store" });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200) || res.statusText}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Provider returned non-JSON response");
    }
  } finally {
    clearTimeout(timer);
  }
}

function extractIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids = data
    .map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return Array.from(new Set(ids)).sort();
}

export async function GET(req: NextRequest) {
  const cfg = await getProviderConfig();
  const url = new URL(req.url);
  const overrideBase = url.searchParams.get("baseUrl");
  const overrideKey = url.searchParams.get("apiKey");

  const baseUrl = (overrideBase ?? cfg.baseUrl ?? "").trim();
  const apiKey = (overrideKey ?? cfg.apiKey ?? "").trim();
  const family = familyOf(cfg.provider);

  try {
    if (family === "anthropic") {
      if (!apiKey) {
        return NextResponse.json({ models: [], error: "API key required to list Anthropic models." });
      }
      const endpoint = modelsUrl(baseUrl || ANTHROPIC_DEFAULT_BASE);
      const payload = await fetchJson(endpoint, {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        accept: "application/json",
      });
      return NextResponse.json({ models: extractIds(payload) });
    }

    // OpenAI-family (openai, openai-codex, openai-compatible)
    const isLocal = cfg.provider === "openai-compatible";
    if (!apiKey && !isLocal) {
      return NextResponse.json({ models: [], error: "API key required to list models." });
    }
    const endpoint = modelsUrl(baseUrl || OPENAI_DEFAULT_BASE);
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const payload = await fetchJson(endpoint, headers);
    return NextResponse.json({ models: extractIds(payload) });
  } catch (err) {
    const msg = (err as Error).message || "Failed to fetch models";
    // Fall back to the provider's default model so the datalist isn't empty.
    const fallback = PROVIDERS[cfg.provider]?.defaultModel;
    return NextResponse.json({ models: fallback ? [fallback] : [], error: msg });
  }
}
