import "server-only";
import { OpenAIAdapter } from "@copilotkit/runtime";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

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
