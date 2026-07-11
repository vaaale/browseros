import "server-only";
import { complete } from "@/lib/agent/llm";
import { hasCredentials } from "@/lib/agent/provider";

// Conversation title generation. A stateless LLM call (never enters the visible
// chat history) used by both the /api/assistant/title route and the v2
// title-generation run hook.

const TITLE_SYSTEM = [
  "You write concise, descriptive titles for chat conversations.",
  "Reply with ONLY the title — no quotes, no preface like 'Title:', no trailing punctuation.",
  "Maximum 6 words, sentence case. Focus on the user's intent or topic.",
  "Good examples: 'Code review discussion', 'Weather forecast query', 'Refactor auth middleware', 'Debug failing test suite'.",
].join(" ");

const MAX_EXCERPT = 2000;
const MAX_TITLE_LEN = 80;

function stripThinking(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function cleanTitle(raw: string): string {
  let t = stripThinking(raw);
  t = t.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? "";
  t = t.replace(/^["'`*_]+|["'`*_]+$/g, "").trim();
  t = t.replace(/^(title|conversation title)\s*[:\-—]\s*/i, "").trim();
  t = t.replace(/[.!?,:;]+$/, "").trim();
  if (t.length > MAX_TITLE_LEN) t = t.slice(0, MAX_TITLE_LEN - 1).trimEnd() + "…";
  return t;
}

/** Generate a title from the first exchange. Throws on provider failure (the
 *  route maps that to a 502); returns "" when no credentials are configured. */
export async function generateTitle(userMessage: string, assistantMessage: string): Promise<string> {
  if (!(await hasCredentials())) return "";
  const prompt = [
    `User: ${stripThinking(userMessage).slice(0, MAX_EXCERPT)}`,
    "",
    `Assistant: ${stripThinking(assistantMessage).slice(0, MAX_EXCERPT)}`,
    "",
    "Write the title.",
  ].join("\n");
  const raw = await complete({ system: TITLE_SYSTEM, prompt, maxTokens: 65535 });
  return cleanTitle(raw);
}
