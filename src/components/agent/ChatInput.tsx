"use client";

import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useChatContext, type InputProps } from "@copilotkit/react-ui";
import {
  clearUserStop,
  hasActiveToolRuns,
  signalUserStop,
  subscribeActiveToolRuns,
} from "@/lib/agent/tool-kernel";

// The chat's single Stop control. CopilotKit's default Input flips its
// send-button into a stop-button only while `inProgress` (the model streaming);
// during client tool execution `inProgress` is false, so the default shows a
// disabled Send and the chat looks frozen with no way to cancel. This custom
// Input (CopilotChat's supported `Input` slot) keeps the SAME structure and CSS
// classes as the default but treats "busy" as streaming OR tool-executing:
//  - streaming stop → onStop() (aborts the run, as before);
//  - tool-exec stop → abortActiveToolRuns() settles every in-flight handler
//    with an in-band "aborted by user" error the agent can react to, and
//    onStop() closes out any run state.
// It also announces the stop (bos:agent-stop) so the activity pill can stop
// showing "Working…" for aborted turns that never receive a tool result.

const MAX_ROWS = 5;

export function ChatInput({ inProgress, onSend, onStop, onUpload, hideStopButton }: InputProps) {
  const context = useChatContext();
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const toolRunning = useSyncExternalStore(subscribeActiveToolRuns, hasActiveToolRuns, () => false);
  const busy = inProgress || toolRunning;

  const canSend = !busy && text.trim().length > 0;
  const canStop = busy && !hideStopButton;

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight || "20") || 20;
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_ROWS)}px`;
  }, []);

  const send = useCallback(() => {
    const value = text.trim();
    if (!value) return;
    setText("");
    requestAnimationFrame(autoResize);
    // A fresh user message is an explicit command — end stop suppression.
    clearUserStop();
    void onSend(value);
  }, [text, onSend, autoResize]);

  const stop = useCallback(() => {
    // Order matters: onStop → stopGeneration → agent.abortRun() (patched by
    // CopilotKit's RunHandler during a run) aborts the core run controller,
    // which suppresses the automatic follow-up run. signalUserStop() then
    // settles the running handler AND flags the turn's queued handlers.
    try {
      onStop?.();
    } catch {
      /* best-effort */
    }
    signalUserStop();
    window.dispatchEvent(new CustomEvent("bos:agent-stop"));
  }, [onStop]);

  return (
    <div className="copilotKitInputContainer">
      <div className="copilotKitInput" onClick={() => textareaRef.current?.focus()}>
        <textarea
          ref={textareaRef}
          rows={1}
          placeholder={context.labels.placeholder}
          value={text}
          data-testid="copilot-chat-textarea"
          onChange={(e) => {
            setText(e.target.value);
            autoResize();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend) send();
            }
          }}
          style={{ resize: "none", overflowY: "auto" }}
        />
        <div className="copilotKitInputControls">
          {onUpload && (
            <button type="button" onClick={onUpload} className="copilotKitInputControlButton" aria-label="Add attachment">
              {context.icons.uploadIcon}
            </button>
          )}
          <div style={{ flexGrow: 1 }} />
          <button
            type="button"
            disabled={!canSend && !canStop}
            onClick={canStop ? stop : send}
            data-copilotkit-in-progress={busy}
            data-testid="copilot-send-button"
            className="copilotKitInputControlButton"
            aria-label={canStop ? "Stop" : "Send"}
          >
            {canStop ? context.icons.stopIcon : context.icons.sendIcon}
          </button>
        </div>
      </div>
    </div>
  );
}
