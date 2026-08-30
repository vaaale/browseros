import { NextResponse } from "next/server";
import { complete, embed } from "@/lib/agent/llm";
import { hasCredentials, getProviderConfig, getProviderConfigView, resolveEmbeddingConfig } from "@/lib/agent/provider";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Validates the configured provider by issuing a tiny live completion, PLUS
// (028-memory-curation-retrieval, N1) a distinct 1-token embeddings probe so
// an "unknown" availability (e.g. a local/Responses endpoint) can resolve to
// a real available/unsupported verdict on demand — never auto-probed on save.
export async function POST() {
  if (!(await hasCredentials())) {
    return NextResponse.json({ ok: false, error: "No API key configured for this provider." });
  }
  const result: {
    ok: boolean;
    provider?: string;
    model?: string;
    sample?: string;
    error?: string;
    embeddings: { available: boolean; error?: string };
  } = { ok: false, embeddings: { available: false } };
  try {
    const view = await getProviderConfigView();
    // Uses the configured max-tokens so "thinking" models have room to emit
    // final content after their reasoning phase.
    const text = await complete({ prompt: "Reply with the single word: OK" });
    result.ok = true;
    result.provider = view.provider;
    result.model = view.model;
    result.sample = text.trim().slice(0, 120);
  } catch (err) {
    result.error = (err as Error).message;
  }

  try {
    const c = await getProviderConfig();
    const resolved = resolveEmbeddingConfig(c);
    if (!resolved.enabled) {
      result.embeddings = { available: false, error: "Embeddings are disabled (no model configured, or the provider has no first-party embeddings endpoint)." };
    } else {
      const vector = await embed(resolved, "connection test");
      result.embeddings = vector
        ? { available: true }
        : { available: false, error: "The endpoint did not return an embedding (unsupported, unauthenticated, or unreachable)." };
    }
  } catch (err) {
    result.embeddings = { available: false, error: (err as Error).message };
  }

  return NextResponse.json(result);
}
