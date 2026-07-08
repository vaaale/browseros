import "server-only";
import { OpenAIAdapter } from "@copilotkit/runtime";
import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";
import { normalizeApiBase } from "@/lib/agent/provider-meta";

// Some local LLM servers use Jinja chat templates that require at least one
// user-role message. CopilotKit's structured-output/parser-generation requests
// sometimes produce sequences with only system + tool messages, which causes the
// template to throw "No user query found in messages." Inject a minimal user turn
// immediately before the first assistant turn (or at the end) when none exists.
const ensureUserMessage: LanguageModelMiddleware = {
  specificationVersion: "v3",
  transformParams: async ({ params }) => {
    type AnyMsg = { role: string; content: unknown };
    const msgs = params.prompt as AnyMsg[];
    if (msgs.some((m) => m.role === "user")) return params;
    const insertAt = msgs.findIndex((m) => m.role === "assistant");
    const pos = insertAt >= 0 ? insertAt : msgs.length;
    const patched = [...msgs];
    patched.splice(pos, 0, { role: "user", content: [{ type: "text", text: "." }] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { ...params, prompt: patched as any };
  },
};

// CopilotKit's v2 runtime calls serviceAdapter.getLanguageModel(). The default
// @ai-sdk/openai model targets OpenAI's Responses API (/responses), which local
// OpenAI-compatible servers rarely implement — producing the broken stream that
// surfaces as "text part not found". Forcing the Chat Completions API (.chat)
// routes requests to /chat/completions through the BOS normalization proxy,
// which also surfaces reasoning tokens as content.
export class OpenAIChatAdapter extends OpenAIAdapter {
  getLanguageModel(): LanguageModel {
    const client = this.openai;
    const base = createOpenAI({ baseURL: client.baseURL, apiKey: client.apiKey ?? undefined }).chat(this.model);
    return wrapLanguageModel({ model: base, middleware: ensureUserMessage });
  }
}

// For the "openai-responses" provider: use @ai-sdk/openai's default model
// (no .chat()), which targets the Responses API (/responses). Base URL is
// normalised so users can paste the full endpoint path without breaking it.
export class OpenAIResponsesAdapter extends OpenAIAdapter {
  getLanguageModel(): LanguageModel {
    const client = this.openai;
    const baseURL = client.baseURL ? normalizeApiBase(client.baseURL) : undefined;
    const base = createOpenAI({ baseURL, apiKey: client.apiKey ?? undefined })(this.model);
    return wrapLanguageModel({ model: base, middleware: ensureUserMessage });
  }
}
