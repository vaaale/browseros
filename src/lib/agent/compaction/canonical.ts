import "server-only";
import { createHash } from "crypto";
import type { CompactionPrompt } from "./estimate";

// Shape-independent canonical form for the sidecar's spanHash (FR-010). The
// summarizer sees the client transcript `/Documents/Chats/<id>.json`; the
// middleware sees the AI-SDK v3 prompt. Both are canonicalized here so a
// coherent `spanHash` can be checked from either side.

export interface CanonicalMsg {
  role: string;
  parts: string[];
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** Client-transcript message shape (mirrors what /Documents/Chats/<id>.json
 *  writes). We only look at role/content/toolCalls — anything else the client
 *  attaches (ids, timestamps) is ignored so hashes are content-derived. */
export interface ClientMessageLike {
  role?: unknown;
  content?: unknown;
  toolCalls?: unknown;
}

function canonicalizeClientContent(content: unknown): string[] {
  if (content == null) return [];
  if (typeof content === "string") {
    const trimmed = content.replace(/\s+$/g, "");
    return trimmed ? [`text:${trimmed}`] : [];
  }
  if (Array.isArray(content)) {
    const out: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") { out.push(safeJson(part)); continue; }
      const p = part as { type?: string; text?: string; toolName?: string; toolCallId?: string; input?: unknown; output?: unknown };
      if (p.type === "text") { const t = (p.text ?? "").replace(/\s+$/g, ""); if (t) out.push(`text:${t}`); }
      else if (p.type === "tool-call") out.push(`tool-call:${p.toolName ?? ""}:${safeJson(p.input)}`);
      else if (p.type === "tool-result") out.push(`tool-result:${p.toolName ?? ""}:${safeJson(p.output)}`);
      else if (p.type === "reasoning") { const t = (p.text ?? "").replace(/\s+$/g, ""); if (t) out.push(`reasoning:${t}`); }
      else out.push(safeJson(part));
    }
    return out;
  }
  return [safeJson(content)];
}

export function canonicalizeClientMessages(messages: ClientMessageLike[]): CanonicalMsg[] {
  const out: CanonicalMsg[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const role = typeof m.role === "string" ? m.role : "unknown";
    const parts = canonicalizeClientContent(m.content);
    if (Array.isArray(m.toolCalls)) {
      for (const c of m.toolCalls) {
        if (!c || typeof c !== "object") continue;
        const call = c as { name?: unknown; toolName?: unknown; input?: unknown; arguments?: unknown };
        const name = String(call.name ?? call.toolName ?? "");
        parts.push(`tool-call:${name}:${safeJson(call.input ?? call.arguments ?? {})}`);
      }
    }
    if (parts.length === 0) continue;
    out.push({ role, parts });
  }
  return out;
}

export function canonicalizePromptMessages(messages: CompactionPrompt): CanonicalMsg[] {
  const out: CanonicalMsg[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      const t = String(m.content).replace(/\s+$/g, "");
      out.push({ role: "system", parts: t ? [`text:${t}`] : [] });
      continue;
    }
    out.push({ role: m.role, parts: canonicalizeClientContent(m.content as unknown) });
  }
  return out;
}

/** SHA-256 over the canonical form. Deterministic and shape-independent. */
export function hashCanonical(messages: CanonicalMsg[]): string {
  const hash = createHash("sha256");
  for (const m of messages) {
    hash.update(m.role);
    hash.update("\x1f");
    for (const p of m.parts) {
      hash.update(p);
      hash.update("\x1e");
    }
    hash.update("\x1d");
  }
  return hash.digest("hex");
}
