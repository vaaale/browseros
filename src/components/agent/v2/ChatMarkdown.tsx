"use client";

import { memo } from "react";
import { Markdown } from "@copilotkit/react-ui";
import { markdownRenderers } from "@/components/agent/MarkdownRenderers";

// Markdown for v2 chat messages, reusing the SAME code renderer (Prism
// highlighting + HTML live preview) so v2 output matches the current chat.
// CopilotKit's standalone <Markdown> is used purely as a react-markdown
// wrapper for now — the transitive react-markdown@8 can't be imported directly
// (its shipped .ts types break under modern @types/react). Milestone D swaps
// this for a direct react-markdown dependency when CopilotKit is removed.
//
// Memoized on `content`: parsing markdown + Prism-highlighting code blocks is
// real synchronous work, redone on every render otherwise — with an
// unmemoized message list, that meant every historical message's markdown
// was re-parsed on every unrelated store update (e.g. each streamed token of
// a DIFFERENT message).
export const ChatMarkdown = memo(function ChatMarkdown({ content }: { content: string }) {
  return (
    <div className="bos-chat-markdown copilotKitMarkdown break-words text-sm leading-relaxed">
      <Markdown content={content} components={markdownRenderers} />
    </div>
  );
});
