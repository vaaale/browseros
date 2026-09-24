// SET A — the behavioural contract of the six VFS CRUD tools as the CURRENT
// (browser-executed) implementation satisfies it. Every test here passes
// against `claude` as of this change; they are the baseline the server-side
// port must reproduce exactly.
//
// WHAT THIS ACTUALLY DRIVES. The tool handlers themselves live in
// src/components/agent/v2/FrontendToolsV2.tsx — a "use client" React module the
// unit runner cannot import. What they contain, though, is only a call to
// `fsClient.scoped(conversationId).<op>` plus a fixed result string; all of the
// behaviour under test (path jail, mount routing, the branch gate, the
// read-only store) is on the far side of `/api/fs`. So this driver issues the
// same requests `fsClient.scoped()` issues — same URL, same `op`, same
// `x-bos-conversation` header — against the real route handlers, and applies
// the same result shaping.
//
// That replication is the honest limitation of this file, and it is bounded:
// `file-tools-parity.test.ts` pins the declared tool schemas so the shaping
// asserted here cannot drift from what the model is actually offered.
//
//   npm run test:unit -- tests/assistant/file-tools-frontend-path.test.ts

import "../services/_stub-server-only";
import { test } from "@playwright/test";
import { NextRequest } from "next/server";
import {
  FILE_TOOL_SCENARIOS,
  setupScenario,
  type DriverResult,
  type FileToolDriver,
} from "./file-tools/_contract";

// Must match FEATURE_CONVERSATION_HEADER (@/lib/specs/feature-context) and the
// CONVERSATION_HEADER copy in src/lib/os-client.ts — the header the browser's
// `fsClient.scoped(conversationId)` sets on every op.
const CONVERSATION_HEADER = "x-bos-conversation";

/** Unwrap a route response the way `jsonOrThrow` + the client tool kernel do:
 *  a non-2xx becomes the in-band error string the model sees. */
async function unwrap<T>(res: Response, pick: (data: T) => string): Promise<DriverResult> {
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) return { ok: false, message: data.error ?? `Request failed (${res.status})` };
  return { ok: true, text: pick(data) };
}

async function get(conversationId: string, op: string, path: string): Promise<Response> {
  const { GET } = await import("../../src/app/api/fs/route");
  return GET(
    new NextRequest(`http://local/api/fs?op=${op}&path=${encodeURIComponent(path)}`, {
      headers: { [CONVERSATION_HEADER]: conversationId },
    }),
  );
}

async function post(conversationId: string, body: Record<string, unknown>): Promise<Response> {
  const { POST } = await import("../../src/app/api/fs/route");
  return POST(
    new NextRequest("http://local/api/fs", {
      method: "POST",
      headers: { "Content-Type": "application/json", [CONVERSATION_HEADER]: conversationId },
      body: JSON.stringify(body),
    }),
  );
}

/** The result strings below are copied verbatim from the handlers in
 *  FrontendToolsV2.tsx — they are part of the tool contract (an agent reads
 *  them, and `ephemeral-subagent-tools.test.ts` asserts on `Wrote <path>.`). */
const frontendPathDriver: FileToolDriver = {
  label: "frontend-path",

  list: async (conversationId, path) =>
    unwrap<{ entries: { name: string; path: string; type: string; size: number }[] }>(
      await get(conversationId, "list", path ?? "/"),
      (d) => JSON.stringify(d.entries.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size }))),
    ),

  read: async (conversationId, path) =>
    unwrap<{ content: string }>(await get(conversationId, "read", path), (d) => d.content),

  write: async (conversationId, path, content) =>
    unwrap(await post(conversationId, { op: "write", path, content }), () => `Wrote ${path}.`),

  mkdir: async (conversationId, path) =>
    unwrap(await post(conversationId, { op: "mkdir", path }), () => `Created folder ${path}.`),

  remove: async (conversationId, path) =>
    unwrap(await post(conversationId, { op: "delete", path }), () => `Deleted ${path}.`),

  rename: async (conversationId, from, to) =>
    unwrap(await post(conversationId, { op: "rename", path: from, to }), () => `Renamed ${from} to ${to}.`),
};

for (const scenario of FILE_TOOL_SCENARIOS) {
  test(`[frontend-path] ${scenario.name}`, async () => {
    const env = await setupScenario(scenario.name.slice(0, 24).replace(/[^a-z0-9]+/gi, "-"));
    try {
      await scenario.run(frontendPathDriver, env);
    } finally {
      env.cleanup();
    }
  });
}
