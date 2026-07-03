"use client";

import { useCopilotAction } from "@/components/agent/gated-action";
import { getSessionId } from "@/lib/logging/client/session";

// Sandboxed command execution for the main chat. Keys the sandbox on the browser
// session id (+ "main"); sub-agents call the executor server-side with their own
// (session, agent) key. Off by default — enable in Settings → Command Execution.
export function RunCommandActions() {
  useCopilotAction({
    name: "run_command",
    description:
      "Run a command in a sandboxed environment (Settings → Command Execution; off by default). language: 'bash' (default, `bash -lc`), 'python' (`ipython -c`), or 'node' (`node -e`). Use this to run skill scripts and general commands. Returns merged stdout/stderr, exit code, and duration; killed if it produces no output for the idle timeout or exceeds the max timeout.",
    parameters: [
      { name: "command", type: "string", description: "The command or code to run.", required: true },
      { name: "language", type: "string", description: "bash (default) | python | node", required: false },
      { name: "timeoutMs", type: "number", description: "Optional per-call max timeout in ms (capped by Settings).", required: false },
    ],
    handler: async ({ command, language, timeoutMs }) => {
      const res = await fetch("/api/system/run-command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, language, timeoutMs, sessionId: getSessionId(), agentId: "main" }),
      }).then((r) => r.json());
      return res.error ? `Error: ${res.error}` : JSON.stringify(res);
    },
  });

  return null;
}
