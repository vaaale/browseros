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
    const config = await updateProviderConfig({
      provider,
      apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
      baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
      maxTokens: typeof body.maxTokens === "number" ? body.maxTokens : undefined,
      maxInputTokens:
        body.maxInputTokens === null ? undefined : typeof body.maxInputTokens === "number" ? body.maxInputTokens : undefined,
    });
    return NextResponse.json({ config });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
