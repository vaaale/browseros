import { NextRequest, NextResponse } from "next/server";
import { complete } from "@/lib/agent/llm";
import { hasCredentials } from "@/lib/agent/provider";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Background title generation for new conversations. Runs as a separate,
// stateless LLM call so the prompt/response never enters the user-visible chat
// history. Invoked once per conversation by the client after the first
// settled user→assistant exchange.

const TITLE_SYSTEM = [
  "You write concise, descriptive titles for chat conversations.",
  "Reply with ONLY the title — no quotes, no preface like 'Title:', no trailing punctuation.",
  "Maximum 6 words, sentence case. Focus on the user's intent or topic.",
  "Good examples: 'Code review discussion', 'Weather forecast query', 'Refactor auth middleware', 'Debug failing test suite'.",
].join(" ");

const MAX_EXCERPT = 2000;
const MAX_TITLE_LEN = 80;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const userMessage = typeof body?.userMessage === "string" ? body.userMessage : "";
    const assistantMessage = typeof body?.assistantMessage === "string" ? body.assistantMessage : "";
    if (!userMessage.trim()) {
      return NextResponse.json({ error: "userMessage is required" }, { status: 400 });
    }
    if (!(await hasCredentials())) {
      return NextResponse.json({ error: "No AI provider configured." }, { status: 503 });
    }

    const prompt = [
      `User: ${stripThinking(userMessage).slice(0, MAX_EXCERPT)}`,
      "",
      `Assistant: ${stripThinking(assistantMessage).slice(0, MAX_EXCERPT)}`,
      "",
      "Write the title.",
    ].join("\n");

    const raw = await complete({ system: TITLE_SYSTEM, prompt, maxTokens: 64 });
    const title = cleanTitle(raw);
    if (!title) return NextResponse.json({ error: "Empty title" }, { status: 502 });
    return NextResponse.json({ title });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

// Strip <think>...</think> reasoning blocks emitted by thinking models so they
// don't leak into the title prompt.
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
