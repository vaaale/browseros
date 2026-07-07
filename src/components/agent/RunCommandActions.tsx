"use client";

import { useCopilotAction } from "@copilotkit/react-core";
import { getSessionId } from "@/lib/logging/client/session";

// Sandboxed command execution for the main chat. Keys the sandbox on the browser
// session id (+ "main"); sub-agents call the executor server-side with their own
// (session, agent) key. Off by default — enable in Settings → Command Execution.
export function RunCommandActions() {
  useCopilotAction({
    name: "run_command",
    description:
      "Run a command in a sandboxed environment (Settings → Command Execution; off by default). language: 'bash' (default, `bash -lc`), 'python' (`ipython -c`), or 'node' (`node -e`). " +
      "WORKSPACE: the working directory /workspace IS a folder in the user's file system (it appears in the Files app). Files you create under /workspace are ALREADY SAVED and visible to the user — do NOT copy/move them elsewhere and do NOT use file_write to 'transfer' them. Only /workspace (and /tmp) exist in the sandbox; other Files folders like /Documents are NOT mounted, so don't cd/copy into them. " +
      "The image comes with common tools preinstalled (python + python-pptx/markitdown/Pillow, node + pptxgenjs, LibreOffice, poppler) — avoid npm/pip install (the sandbox usually has no network). " +
      "To run a SKILL's bundled scripts, pass `skill` = its id: the skill's files are staged into /workspace so the relative paths in its SKILL.md (e.g. `python scripts/office/unpack.py`) work as-written. " +
      "Returns merged stdout/stderr, exit code, and duration; killed if it produces no output for the idle timeout or exceeds the max timeout.",
    parameters: [
      { name: "command", type: "string", description: "The command or code to run.", required: true },
      { name: "language", type: "string", description: "bash (default) | python | node", required: false },
      { name: "skill", type: "string", description: "Optional skill id: stage that skill's files into the working dir so its SKILL.md relative paths resolve.", required: false },
      { name: "timeoutMs", type: "number", description: "Optional per-call max timeout in ms (capped by Settings).", required: false },
    ],
    handler: async ({ command, language, skill, timeoutMs }) => {
      const res = await fetch("/api/system/run-command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, language, skill, timeoutMs, sessionId: getSessionId(), agentId: "main" }),
      }).then((r) => r.json());
      return res.error ? `Error: ${res.error}` : JSON.stringify(res);
    },
  });

  return null;
}
