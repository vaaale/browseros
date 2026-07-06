import "server-only";
import { OpenAIAdapter } from "@copilotkit/runtime";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { normalizeApiBase } from "@/lib/agent/provider-meta";

// CopilotKit's v2 runtime calls serviceAdapter.getLanguageModel(). The default
// @ai-sdk/openai model targets OpenAI's Responses API (/responses), which local
// OpenAI-compatible servers rarely implement — producing the broken stream that
// surfaces as "text part not found". Forcing the Chat Completions API (.chat)
// routes requests to /chat/completions through the BOS normalization proxy,
// which also surfaces reasoning tokens as content.
export class OpenAIChatAdapter extends OpenAIAdapter {
  getLanguageModel(): LanguageModel {
    const client = this.openai;
    return createOpenAI({ baseURL: client.baseURL, apiKey: client.apiKey ?? undefined }).chat(this.model);
  }
}

// For the "openai-responses" provider: use @ai-sdk/openai's default model
// (no .chat()), which targets the Responses API (/responses). Base URL is
// normalised so users can paste the full endpoint path without breaking it.
export class OpenAIResponsesAdapter extends OpenAIAdapter {
  getLanguageModel(): LanguageModel {
    const client = this.openai;
    const baseURL = client.baseURL ? normalizeApiBase(client.baseURL) : undefined;
    return createOpenAI({ baseURL, apiKey: client.apiKey ?? undefined })(this.model);
  }
}
