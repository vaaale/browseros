import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import * as specfs from "@/lib/dev/spec-fs";
import { getConversationActiveFeatureBranch } from "@/lib/agent/conversations-server";

// Spec-authoring tools (ported from SpecActions.tsx), now natively implemented
// (025-agent-delegation-v2, Phase 4 — retiring the legacy engine): these used
// to be adapted from `src/lib/agent/subagents/tools.ts`'s `makeSpecTools`/
// `SPEC_TOOLS`; that indirection is gone now that this was the only consumer.
// Specs live in external stores (018): a path is STORE-PREFIXED
// `<storeId>/<rel>` (list stores with an empty path). Each call resolves the
// conversation's active feature branch server-side and binds the spec store
// to it (020), so specs land on the same branch the Developer builds.
export function specTools(): Record<string, AssistantTool> {
  async function branchFor(conversationId: string): Promise<{ branch?: string } | undefined> {
    const branch = await getConversationActiveFeatureBranch(conversationId).catch(() => undefined);
    return branch ? { branch } : undefined;
  }

  return {
    spec_list: serverTool(
      "spec_list",
      "List entries in the spec stores. An empty/omitted path lists the available stores (e.g. 'bos-system-specs', 'user-specs'); a store-prefixed path like 'user-specs/003-my-feature' lists inside a store.",
      schema({ path: p.str("Store-prefixed dir, e.g. 'user-specs' or 'user-specs/003-x'. Empty = list stores.") }),
      async (input, ctx) => JSON.stringify(await specfs.listDir((input.path as string) || "", await branchFor(ctx.conversationId))),
    ),
    spec_read: serverTool(
      "spec_read",
      "Read a specification artifact by its STORE-PREFIXED path, e.g. 'bos-system-specs/001-build-studio/spec.md'. For spec-kit templates use spec_template_read instead.",
      schema({ path: p.str("Store-prefixed artifact path") }, ["path"]),
      async (input, ctx) => specfs.readFile(input.path as string, await branchFor(ctx.conversationId)),
    ),
    spec_write: serverTool(
      "spec_write",
      "Create or overwrite a specification artifact by STORE-PREFIXED path (e.g. 'user-specs/003-x/spec.md'). New user specs go in the user store; writes go to the conversation's active feature branch when one is set. Build the body from a template via spec_template_read.",
      schema({ path: p.str("Store-prefixed artifact path"), content: p.str("Full file content") }, ["path", "content"]),
      async (input, ctx) =>
        `Wrote ${await specfs.writeFile(input.path as string, (input.content as string) ?? "", await branchFor(ctx.conversationId))}`,
    ),
    spec_edit: serverTool(
      "spec_edit",
      "Replace a unique snippet of text in a spec artifact (STORE-PREFIXED path; the search text must occur exactly once).",
      schema(
        { path: p.str("Store-prefixed artifact path"), find: p.str("Exact text to find (must occur exactly once)"), replace: p.str("Replacement text") },
        ["path", "find", "replace"],
      ),
      async (input, ctx) =>
        `Edited ${await specfs.editFile(input.path as string, input.find as string, (input.replace as string) ?? "", await branchFor(ctx.conversationId))}`,
    ),
    spec_search: serverTool(
      "spec_search",
      "Search spec content across all stores for a string. Returns matching path:line:text. Optionally restrict to a store-prefixed subdirectory.",
      schema(
        { query: p.str("Search string"), dir: p.str("Store-prefixed subdir to search (e.g. 'user-specs'); omit to search all stores.") },
        ["query"],
      ),
      async (input, ctx) => {
        const bound = await branchFor(ctx.conversationId);
        return JSON.stringify(
          await specfs.search(input.query as string, { dir: input.dir as string | undefined, branch: bound?.branch }),
        );
      },
    ),
    spec_template_read: serverTool(
      "spec_template_read",
      "Read a spec-kit template or command prompt from the engine at .specify/templates (e.g. 'spec-template.md', 'plan-template.md', 'commands/specify.md'). Read-only.",
      schema({ path: p.str("Template path under .specify/templates") }, ["path"]),
      async (input) => specfs.readTemplate(input.path as string),
    ),
    spec_template_list: serverTool(
      "spec_template_list",
      "List available spec-kit templates/command prompts under .specify/templates (optionally a subdir like 'commands').",
      schema({ path: p.str("Subdir under .specify/templates, e.g. 'commands'") }),
      async (input) => JSON.stringify(await specfs.listTemplates((input.path as string) || "")),
    ),
  };
}
