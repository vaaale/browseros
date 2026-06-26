"use client";

import { useEffect, useState } from "react";
import { CopilotChat } from "@copilotkit/react-ui";
import "@copilotkit/react-ui/styles.css";
import type { AppProps } from "./types";

const FALLBACK_INSTRUCTIONS =
  "You are the BrowserOS assistant. You can launch apps, manage the virtual file system, open web pages, change the wallpaper, connect MCP servers, delegate to sub-agents, remember things, and build new apps using the provided actions. Prefer doing over describing, and be concise.";

const DARK_THEME: React.CSSProperties = {
  // CopilotKit theming hooks — keep the chat consistent with the OS dark shell.
  ["--copilot-kit-background-color" as string]: "#0f1117",
  ["--copilot-kit-secondary-color" as string]: "#1a1d27",
  ["--copilot-kit-separator-color" as string]: "rgba(255,255,255,0.08)",
  ["--copilot-kit-muted-color" as string]: "rgba(255,255,255,0.45)",
  ["--copilot-kit-primary-color" as string]: "#5b8cff",
  ["--copilot-kit-contrast-color" as string]: "#ffffff",
  ["--copilot-kit-secondary-contrast-color" as string]: "#e7e9ee",
};

export function ChatApp(_props: AppProps) {
  const [instructions, setInstructions] = useState(FALLBACK_INSTRUCTIONS);

  useEffect(() => {
    // Use the agent's self-editable profile instructions when available.
    fetch("/api/agent/profile")
      .then((r) => r.json())
      .then((d) => d.composed && setInstructions(d.composed))
      .catch(() => {});
  }, []);

  return (
    <div className="h-full" style={DARK_THEME}>
      <CopilotChat
        className="h-full"
        instructions={instructions}
        labels={{
          title: "BOS Assistant",
          initial:
            "Hi — I'm your BrowserOS assistant. I can open apps, manage files, browse the web, and change your wallpaper. What can I do for you?",
        }}
      />
    </div>
  );
}
