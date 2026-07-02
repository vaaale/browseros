"use client";

import { useCopilotAction } from "@/components/agent/gated-action";

// Native bash tool for the assistant. Runs `bash -lc <command>` on the server.
// Off by default — the user must flip Settings → System Tools → Enabled. Output
// is truncated to ~16KB in the returned string; the server-side cap is 8MB.
export function BashActions() {
  useCopilotAction({
    name: "runBash",
    description:
      "Run a shell command via `bash -lc` on the BrowserOS host and return its exit code, stdout, stderr, and duration. Off by default — the user must enable it in Settings → System Tools. Output is truncated to ~16KB. Default timeout 120s; max 600s. Use this when you need to inspect the host, run build/test commands, or drive tools that don't have a dedicated action.",
    parameters: [
      { name: "command", type: "string", description: "The shell command to run (passed to `bash -lc`).", required: true },
      { name: "cwd", type: "string", description: "Working directory. Defaults to the BrowserOS process cwd.", required: false },
      { name: "timeoutMs", type: "number", description: "Timeout in milliseconds. Default 120000, max 600000.", required: false },
    ],
    handler: async ({ command, cwd, timeoutMs }) => {
      const res = await fetch("/api/system/bash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, cwd, timeoutMs }),
      }).then((r) => r.json());
      if (res.error) return `Error: ${res.error}`;
      return JSON.stringify(res);
    },
  });

  return null;
}
