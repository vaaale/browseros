import { NextResponse } from "next/server";
import { complete } from "@/lib/agent/llm";
import { hasCredentials, getProviderConfigView } from "@/lib/agent/provider";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Validates the configured provider by issuing a tiny live completion.
export async function POST() {
  if (!(await hasCredentials())) {
    return NextResponse.json({ ok: false, error: "No API key configured for this provider." });
  }
  try {
    const view = await getProviderConfigView();
    // Uses the configured max-tokens so "thinking" models have room to emit
    // final content after their reasoning phase.
    const text = await complete({ prompt: "Reply with the single word: OK" });
    return NextResponse.json({ ok: true, provider: view.provider, model: view.model, sample: text.trim().slice(0, 120) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message });
  }
}
