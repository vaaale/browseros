import { NextRequest, NextResponse } from "next/server";
import { getProviderConfig } from "@/lib/agent/provider";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// OpenAI-compatible proxy that the chat's OpenAI client points at. It:
//  - forwards to the user's configured provider base URL with the real key,
//  - injects the configured max-tokens when the request omits it,
//  - rewrites the streaming response so a model's `reasoning_content`
//    ("thinking" tokens) is surfaced as visible content. This both makes
//    reasoning visible in the chat and prevents the empty-content stream that
//    otherwise aborts with "text part not found".

function upstreamBase(baseUrl?: string): string {
  return (baseUrl && baseUrl.replace(/\/+$/, "")) || "https://api.openai.com/v1";
}

function passthroughHeaders(upstream: Response): Headers {
  const h = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) h.set("Content-Type", ct);
  h.set("Cache-Control", "no-store");
  return h;
}

type Delta = { content?: string | null; reasoning_content?: string; tool_calls?: unknown };

function makeTransformer() {
  // Tracks the reasoning→answer transition so we can insert a visual separator.
  let phase: "none" | "reasoning" | "answer" = "none";

  return function transformChunk(json: Record<string, unknown>): Record<string, unknown> {
    const choices = json.choices as Array<{ delta?: Delta }> | undefined;
    if (!Array.isArray(choices)) return json;
    for (const choice of choices) {
      const delta = choice.delta;
      if (!delta) continue;
      const hasContent = typeof delta.content === "string" && delta.content.length > 0;
      const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";

      // Wrap reasoning in <think>…</think> so the chat can render it as a
      // collapsible block separate from the answer.
      if (hasContent) {
        if (phase === "reasoning") {
          delta.content = `\n</think>\n${delta.content}`;
          phase = "answer";
        } else {
          phase = "answer";
        }
      } else if (reasoning) {
        delta.content = phase === "none" ? `<think>\n${reasoning}` : reasoning;
        phase = "reasoning";
      }
      delete delta.reasoning_content;
    }
    return json;
  };
}

function transformSSE(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const transform = makeTransformer();
  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader();
      const emitLine = (line: string) => {
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload && payload !== "[DONE]") {
            try {
              const json = JSON.parse(payload);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(transform(json))}\n`));
              return;
            } catch {
              /* fall through to raw passthrough */
            }
          }
        }
        controller.enqueue(encoder.encode(`${line}\n`));
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) emitLine(line);
        }
        if (buffer) emitLine(buffer);
      } catch (err) {
        controller.error(err);
        return;
      }
      controller.close();
    },
  });
}

async function forward(req: NextRequest, pathParts: string[]): Promise<Response> {
  const cfg = await getProviderConfig();
  const target = `${upstreamBase(cfg.baseUrl)}/${pathParts.join("/")}`;
  const isChat = pathParts.join("/") === "chat/completions";

  let bodyText: string | undefined;
  let wantStream = false;
  if (req.method === "POST") {
    bodyText = await req.text();
    if (isChat && bodyText) {
      try {
        const body = JSON.parse(bodyText) as Record<string, unknown>;
        wantStream = body.stream === true;
        if (body.max_tokens === undefined && body.max_completion_tokens === undefined) {
          body.max_tokens = cfg.maxTokens;
        }
        bodyText = JSON.stringify(body);
      } catch {
        /* leave body as-is */
      }
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey || "local"}`,
      },
      body: bodyText,
      redirect: "follow",
    });
  } catch (err) {
    return NextResponse.json({ error: { message: `Upstream fetch failed: ${(err as Error).message}` } }, { status: 502 });
  }

  if (isChat && wantStream && upstream.body && upstream.ok) {
    return new NextResponse(transformSSE(upstream.body), {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return new NextResponse(upstream.body, { status: upstream.status, headers: passthroughHeaders(upstream) });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await ctx.params).path);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await ctx.params).path);
}
