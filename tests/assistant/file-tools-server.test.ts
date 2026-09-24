// SET B — the SAME behavioural contract, driven through the server-side
// `file_list` / `file_read` / `file_write` / `file_mkdir` / `file_delete` /
// `file_rename` tools in src/lib/assistant/tools/server/files.ts.
//
// Every case here is byte-identical to the one Set A runs against the browser
// path (both import FILE_TOOL_SCENARIOS from ./file-tools/_contract). If a case
// passes there and fails here, the port changed where or how the tools touch
// the user's VFS — which is the one thing this move must not do.
//
// The driver below calls `execute()` exactly as agent-loop.ts does: raw
// `Record<string, unknown>` input, a real ToolContext carrying the conversation
// id. `serverTool` guarantees execute() never throws, so a failure arrives as
// the in-band `Error: <tool>: <message>` string the model would receive; the
// driver unwraps that back into DriverResult so the shared scenarios can assert
// on the cause.
//
//   npm run test:unit -- tests/assistant/file-tools-server.test.ts

import "../services/_stub-server-only";
import { test } from "@playwright/test";
import type { AssistantTool, ToolContext } from "../../src/lib/assistant/tools";
import {
  FILE_TOOL_SCENARIOS,
  setupScenario,
  type DriverResult,
  type FileToolDriver,
} from "./file-tools/_contract";

function ctx(conversationId: string): ToolContext {
  return {
    signal: new AbortController().signal,
    conversationId,
    agentId: "file-tools-test",
    runId: "file-tools-run",
    onEvent: () => undefined,
    elicit: async () => "",
    delegationDepth: 0,
  };
}

/** `serverTool` reports failure in-band as `Error: <tool>: <message>`. Split
 *  that back apart so the shared scenarios can match on the cause.
 *
 *  Anchored to the tool's OWN name rather than a loose /^Error/ so a result
 *  whose legitimate content merely begins with "Error" is not misread as a
 *  failure. */
function unwrap(name: string, raw: string): DriverResult {
  const prefix = `Error: ${name}: `;
  return raw.startsWith(prefix) ? { ok: false, message: raw.slice(prefix.length) } : { ok: true, text: raw };
}

async function call(name: string, conversationId: string, input: Record<string, unknown>): Promise<DriverResult> {
  const { fileTools } = await import("../../src/lib/assistant/tools/server/files");
  const tool: AssistantTool | undefined = fileTools()[name];
  if (!tool?.execute) throw new Error(`fileTools() does not expose an executable "${name}"`);
  const out = await tool.execute(input, ctx(conversationId));
  return unwrap(name, typeof out === "string" ? out : out.text);
}

const serverDriver: FileToolDriver = {
  label: "server",
  list: (conversationId, path) => call("file_list", conversationId, path === undefined ? {} : { path }),
  read: (conversationId, path) => call("file_read", conversationId, { path }),
  write: (conversationId, path, content) => call("file_write", conversationId, { path, content }),
  mkdir: (conversationId, path) => call("file_mkdir", conversationId, { path }),
  remove: (conversationId, path) => call("file_delete", conversationId, { path }),
  rename: (conversationId, from, to) => call("file_rename", conversationId, { path: from, to }),
};

for (const scenario of FILE_TOOL_SCENARIOS) {
  test(`[server] ${scenario.name}`, async () => {
    const env = await setupScenario(scenario.name.slice(0, 24).replace(/[^a-z0-9]+/gi, "-"));
    try {
      await scenario.run(serverDriver, env);
    } finally {
      env.cleanup();
    }
  });
}
