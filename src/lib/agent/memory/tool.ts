import "server-only";
import { applyBatch, addEntry, replaceEntry, removeEntry, type MemoryTarget, type MemoryOp } from "./curated";
import type { LlmTool } from "@/lib/agent/llm";

function isTarget(t: unknown): t is MemoryTarget {
  return t === "user" || t === "memory";
}

// Normalize ops the model might emit with snake_case keys.
function normalizeOps(raw: unknown): MemoryOp[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => {
    const op = (o ?? {}) as Record<string, unknown>;
    return {
      action: String(op.action ?? "") as MemoryOp["action"],
      content: op.content as string | undefined,
      oldText: (op.oldText ?? op.old_text) as string | undefined,
    };
  });
}

export async function memoryTool(input: {
  action?: string;
  target?: string;
  content?: string;
  oldText?: string;
  operations?: unknown;
}): Promise<string> {
  const target = input.target ?? "memory";
  if (!isTarget(target)) {
    return JSON.stringify({ success: false, error: `Invalid target "${target}". Use "memory" or "user".` });
  }

  let result;
  if (input.operations) {
    result = await applyBatch(target, normalizeOps(input.operations));
  } else {
    switch (input.action) {
      case "add":
        result = await addEntry(target, input.content ?? "");
        break;
      case "replace":
        result = await replaceEntry(target, input.oldText ?? "", input.content ?? "");
        break;
      case "remove":
        result = await removeEntry(target, input.oldText ?? "");
        break;
      default:
        return JSON.stringify({ success: false, error: `Unknown action "${input.action}". Use add, replace, remove, or operations[].` });
    }
  }
  return JSON.stringify(result);
}

const DESCRIPTION =
  "Save durable facts to persistent memory that survive across sessions and are injected into future conversations. " +
  "Keep entries compact and high-signal. WHEN: save proactively when the user states a preference, a correction, or a " +
  "personal detail, or when you learn a stable fact about their environment, conventions, or workflow. Priority: user " +
  "preferences & corrections > environment facts > procedures. The best memory stops the user repeating themselves. " +
  "TARGETS: 'user' = who the user is (identity, role, preferences, style); 'memory' = your notes (environment, conventions, " +
  "tool quirks, lessons). SKIP: trivial/obvious info, easily re-discoverable facts, raw data dumps, task progress, " +
  "completed-work logs. Reusable procedures belong in a SKILL, not memory. To make several changes (e.g. remove stale " +
  "entries to free room AND add a new one) pass an 'operations' array — it applies atomically against the final budget.";

/** The memory tool as an LlmTool, for the review pass and local sub-agents. */
export const MEMORY_LLM_TOOL: LlmTool = {
  description: DESCRIPTION,
  parameters: {
    type: "object",
    properties: {
      target: { type: "string", enum: ["user", "memory"], description: "Which store: 'user' profile or 'memory' notes." },
      action: { type: "string", enum: ["add", "replace", "remove"], description: "Single-op action. Omit when using 'operations'." },
      content: { type: "string", description: "Entry content (required for add/replace)." },
      old_text: { type: "string", description: "A short unique substring of the entry to modify (required for replace/remove)." },
      operations: {
        type: "array",
        description: "Batch of {action, content?, old_text?} applied atomically against the final budget.",
        items: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["add", "replace", "remove"] },
            content: { type: "string" },
            old_text: { type: "string" },
          },
          required: ["action"],
        },
      },
    },
    required: ["target"],
  },
  execute: async (input) =>
    memoryTool({
      action: input.action as string | undefined,
      target: (input.target as string) ?? "memory",
      content: input.content as string | undefined,
      oldText: (input.old_text ?? input.oldText) as string | undefined,
      operations: input.operations,
    }),
};
