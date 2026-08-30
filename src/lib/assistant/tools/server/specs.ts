import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, parallel, schema, p } from "./util";
import * as specfs from "@/lib/dev/spec-fs";
import { getStore } from "@/lib/specs/stores";
import { createItemSpec } from "@/lib/specs/create";
import { getConversationActiveFeatureBranch } from "@/lib/agent/conversations-server";
import type { ToolContext } from "../../tools";

// Marketplace-item spec tools (overrides 018/specify's original "always
// centralize in user-specs" convention for this one target type — a deliberate
// product decision). Scoped ONLY to item-owned stores (owner: "item",
// item-stores.ts): BOS-core/user specs are unaffected and keep using the
// file_* tools on /Specs/user-specs, /Specs/bos-system-specs exactly as
// before. Keeping this boundary crisp means no two tool families ever claim
// the same content.
//
// EVERY op — read AND write — runs against the conversation's active `bos/*`
// feature branch, exactly like /Specs and like BOS's own source. An item's
// content lives in `data/user-apps`, a branch-coupled repo, so its spec travels
// with the item's code and promotes or discards with it.
//
// Reads MUST use the same branch as writes. They briefly did not, and it
// produced a silent read/write desync in production: writes landed in the
// branch's clone while `app_spec_read`/`app_spec_list` kept reporting base's
// copy, so the agent could not see its own writes. It concluded the writes were
// failing, re-issued them, and burned a long loop "diagnosing" a phantom bug —
// and any find/replace it derived from the stale text was being matched against
// a different file than the one it had read.
//
// The former exemption here ("no active feature-branch requirement") existed
// only because item stores had no branch mechanism; they now use the same one
// as everything else.

/** The branch every item-spec op runs against: the conversation's active
 *  feature branch. Absent on a WRITE → spec-fs's own gate (prepareWrite)
 *  refuses it and the message tells the model to call dev_branch_request, so the
 *  elicitation is identical to the one BOS-core spec and source edits trigger.
 *  Absent on a READ → the live content, which is correct: with no branch active
 *  there is nothing else to read. */
async function specCtx(ctx: ToolContext): Promise<specfs.SpecCtx | undefined> {
  const branch = await getConversationActiveFeatureBranch(ctx.conversationId).catch(() => undefined);
  return branch ? { branch } : undefined;
}

async function requireItemStore(path: string, toolName: string): Promise<void> {
  const [storeId] = path.split("/");
  const store = await getStore(storeId);
  if (!store) throw new Error(`Unknown spec store "${storeId}".`);
  if (store.owner !== "item") {
    throw new Error(
      `${toolName} only operates on marketplace-item specs (item-<id>/...). ` +
        `For BOS-core/user specs, use file_read/file_write/file_edit/file_patch on /Specs/... instead.`,
    );
  }
}

export function itemSpecTools(): Record<string, AssistantTool> {
  return {
    app_spec_create: serverTool(
      "app_spec_create",
      "Create a marketplace item's spec.md, bringing the item itself into existence (symlinked, git-committed) even before any app/service/plugin code exists — the SAME mechanism app_install/app_build use. Use this the moment you decide something is going to be a marketplace item, not a BOS-core feature. Omit `id` to derive a fresh one from `name`; pass an existing item's id to add a spec to it (fails if it already has one — use app_spec_write/app_spec_edit instead).",
      schema(
        { name: p.str("Item/feature name"), id: p.str("Explicit item id (optional)"), specBody: p.str("Full spec.md content") },
        ["name", "specBody"],
      ),
      async (input, ctx) => {
        const { id, path } = await createItemSpec({
          name: String(input.name ?? ""),
          id: input.id ? String(input.id) : undefined,
          specBody: String(input.specBody ?? ""),
          branch: (await specCtx(ctx))?.branch,
        });
        return `Created item "${id}" with spec at ${path}`;
      },
    ),
    app_spec_list: parallel(
      serverTool(
        "app_spec_list",
        "List entries in a marketplace item's spec store, e.g. 'item-widget' to list its artifacts.",
        schema({ path: p.str("Store-prefixed dir, e.g. 'item-widget'") }, ["path"]),
        async (input, ctx) => {
          await requireItemStore(String(input.path ?? ""), "app_spec_list");
          return JSON.stringify(await specfs.listDir(String(input.path ?? ""), await specCtx(ctx)));
        },
      ),
    ),
    app_spec_read: parallel(
      serverTool(
        "app_spec_read",
        "Read a marketplace item's spec artifact by its STORE-PREFIXED path, e.g. 'item-widget/spec.md'.",
        schema({ path: p.str("Store-prefixed artifact path") }, ["path"]),
        async (input, ctx) => {
          await requireItemStore(String(input.path ?? ""), "app_spec_read");
          return specfs.readFile(String(input.path ?? ""), await specCtx(ctx));
        },
      ),
    ),
    app_spec_write: serverTool(
      "app_spec_write",
      "Replace the ENTIRE content of an existing marketplace-item spec artifact (STORE-PREFIXED path, e.g. 'item-widget/plan.md'). Prefer app_spec_edit/app_spec_patch for a targeted change. Refused if the item is marketplace-sourced (read-only) rather than the user's own.",
      schema({ path: p.str("Store-prefixed artifact path"), content: p.str("Full file content") }, ["path", "content"]),
      async (input, ctx) => {
        await requireItemStore(String(input.path ?? ""), "app_spec_write");
        return `Wrote ${await specfs.writeFile(String(input.path ?? ""), String(input.content ?? ""), await specCtx(ctx))}`;
      },
    ),
    app_spec_edit: serverTool(
      "app_spec_edit",
      "Replace a unique snippet of text in a marketplace-item spec artifact (STORE-PREFIXED path; the search text must occur exactly once).",
      schema(
        { path: p.str("Store-prefixed artifact path"), find: p.str("Exact text to find (must occur exactly once)"), replace: p.str("Replacement text") },
        ["path", "find", "replace"],
      ),
      async (input, ctx) => {
        await requireItemStore(String(input.path ?? ""), "app_spec_edit");
        return `Edited ${await specfs.editFile(String(input.path ?? ""), String(input.find ?? ""), String(input.replace ?? ""), await specCtx(ctx))}`;
      },
    ),
    app_spec_patch: serverTool(
      "app_spec_patch",
      "Apply one or more targeted find/replace edits to an existing marketplace-item spec artifact (STORE-PREFIXED path) in a single atomic change. Each hunk's `find` must occur exactly once at the moment it applies; hunks apply in order. If any hunk fails, nothing is written.",
      schema(
        {
          path: p.str("Store-prefixed artifact path"),
          hunks: {
            type: "array",
            description: "Ordered edits; each replaces the single occurrence of `find` with `replace`.",
            items: {
              type: "object",
              properties: {
                find: { type: "string", description: "Exact text to find (must be unique when this hunk applies)" },
                replace: { type: "string", description: "Replacement text" },
              },
              required: ["find", "replace"],
            },
          },
        },
        ["path", "hunks"],
      ),
      async (input, ctx) => {
        await requireItemStore(String(input.path ?? ""), "app_spec_patch");
        const hunks = (input.hunks as specfs.SpecHunk[]) ?? [];
        return `Patched ${await specfs.patchFile(String(input.path ?? ""), hunks, await specCtx(ctx))}`;
      },
    ),
  };
}
