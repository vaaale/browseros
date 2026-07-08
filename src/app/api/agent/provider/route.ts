import { NextRequest, NextResponse } from "next/server";
import { getProviderConfigView, updateProviderConfig } from "@/lib/agent/provider";
import { PROVIDER_LIST, PROVIDERS, type ProviderType } from "@/lib/agent/provider-meta";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ config: await getProviderConfigView(), providers: PROVIDER_LIST });
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const provider = body.provider as ProviderType | undefined;
    if (provider && !PROVIDERS[provider]) {
      return NextResponse.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
    }
    // Only forward keys the client explicitly set — `null` means "clear",
    // omitted means "leave unchanged".
    const patch: Parameters<typeof updateProviderConfig>[0] = { provider };
    if (typeof body.apiKey === "string") patch.apiKey = body.apiKey;
    if (typeof body.baseUrl === "string") patch.baseUrl = body.baseUrl;
    if (typeof body.model === "string") patch.model = body.model;
    if ("maxTokens" in body) {
      patch.maxTokens = typeof body.maxTokens === "number" ? body.maxTokens : undefined;
    }
    if ("maxInputTokens" in body) {
      patch.maxInputTokens = typeof body.maxInputTokens === "number" ? body.maxInputTokens : undefined;
    }
    const config = await updateProviderConfig(patch);
    return NextResponse.json({ config });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
