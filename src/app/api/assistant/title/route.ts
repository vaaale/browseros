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
  // Validate input first — a genuine client error (bad/missing body) is the only
  // thing that warrants a 400. Everything downstream (provider unreachable, model
  // error) is a server/upstream failure and MUST NOT masquerade as a 400, or the
  // client treats a transient outage as a permanent bad request.
  let userMessage = "";
  let assistantMessage = "";
  try {
    const body = await req.json();
    userMessage = typeof body?.userMessage === "string" ? body.userMessage : "";
    assistantMessage = typeof body?.assistantMessage === "string" ? body.assistantMessage : "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
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

  try {
    const raw = await complete({ system: TITLE_SYSTEM, prompt, maxTokens: 65535 });
    const title = cleanTitle(raw);
    if (!title) return NextResponse.json({ error: "Empty title" }, { status: 502 });
    return NextResponse.json({ title });
  } catch (err) {
    // The provider call failed (unreachable host, model error, timeout). Report it
    // as a 502 so it's diagnosable and the client can retry on a later turn.
    return NextResponse.json({ error: `Title generation failed: ${(err as Error).message}` }, { status: 502 });
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
