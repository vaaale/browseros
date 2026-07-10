import "server-only";
import type { AssistantTool } from "../../tools";
import { serverTool, schema, p } from "./util";
import { runCommand, type RunLanguage } from "@/lib/system/run-command";

// Sandboxed command execution, ported from RunCommandActions.tsx. The sandbox
// container is keyed on (conversation, agent) — the server-run equivalent of
// the old (browser-session, "main") key.

const LANGS: RunLanguage[] = ["bash", "python", "node"];

export function runCommandTools(): Record<string, AssistantTool> {
  return {
    run_command: serverTool(
      "run_command",
      "Run a command in a sandboxed environment (Settings → Command Execution; off by default). language: 'bash' (default, `bash -lc`), 'python' (`ipython -c`), or 'node' (`node -e`). " +
        "WORKSPACE: the working directory /workspace IS a folder in the user's file system (it appears in the Files app). Files you create under /workspace are ALREADY SAVED and visible to the user — do NOT copy/move them elsewhere and do NOT use file_write to 'transfer' them. Only /workspace (and /tmp) exist in the sandbox; other Files folders like /Documents are NOT mounted, so don't cd/copy into them. " +
        "The image comes with common tools preinstalled (python + python-pptx/markitdown/Pillow, node + pptxgenjs, LibreOffice, poppler) — avoid npm/pip install (the sandbox usually has no network). " +
        "To run a SKILL's bundled scripts, pass `skill` = its id: the skill's files are staged into /workspace so the relative paths in its SKILL.md (e.g. `python scripts/office/unpack.py`) work as-written. " +
        "Returns merged stdout/stderr, exit code, and duration; killed if it produces no output for the idle timeout or exceeds the max timeout.",
      schema(
        {
          command: p.str("The command or code to run."),
          language: p.str("bash (default) | python | node"),
          skill: p.str("Optional skill id: stage that skill's files into the working dir so its SKILL.md relative paths resolve."),
          timeoutMs: p.num("Optional per-call max timeout in ms (capped by Settings)."),
        },
        ["command"],
      ),
      async (input, ctx) => {
        const command = String(input.command ?? "");
        if (!command.trim()) return "Error: run_command: command is required — provide the command or code to run.";
        const language: RunLanguage = LANGS.includes(input.language as RunLanguage)
          ? (input.language as RunLanguage)
          : "bash";
        const result = await runCommand({
          command,
          language,
          skill: typeof input.skill === "string" && input.skill ? input.skill : undefined,
          timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : undefined,
          sessionKey: `${ctx.conversationId}:${ctx.agentId}`,
        });
        return JSON.stringify(result);
      },
    ),
  };
}
