import "server-only";
import type { AssistantTool, ToolExecuteResult } from "../../tools";
import type { Attachment } from "../../messages";
import { serverTool, parallel, schema, p } from "./util";
import { runCommand } from "@/lib/system/run-command";
import * as vfs from "@/os/vfs";

// Mechanical video -> keyframes extraction (040-okf-knowledge-base ingestion
// redesign), via the sandbox's ffmpeg install. Frames come back as image
// attachments (view_image's multi-image sibling) so the calling agent gets
// real visual understanding of the video, not a text description of it.
// Only used as the universal fallback — prefer a provider's native video
// understanding when isNativeVideoUnderstandingAvailable() reports it, since
// sampled frames lose motion/audio the native path would otherwise see.

const DEFAULT_MAX_FRAMES = 8;
const MIN_MAX_FRAMES = 1;
const MAX_MAX_FRAMES = 20;

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function validateWorkspacePath(vfsPath: string): string | null {
  const normalized = vfsPath.trim();
  if (normalized !== "/workspace" && !normalized.startsWith("/workspace/")) return null;
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

export function videoTools(): Record<string, AssistantTool> {
  return {
    // Parallel-safe for the same reasons as file_to_markdown: single-flighted
    // container, and every call writes+collects frames under its OWN unique
    // prefix, so concurrent runs can never pick up each other's frames.
    video_keyframes: parallel(serverTool(
      "video_keyframes",
      "Sample evenly-spaced keyframes from a video already under /workspace, via the sandbox's ffmpeg (Settings → Command Execution must be enabled). Returns the frames to you directly as image content blocks, for real visual understanding. Prefer a provider's native video understanding when available; this is the universal fallback.",
      schema(
        {
          path: p.str("VFS path under /workspace to the source video, e.g. /workspace/clip.mp4."),
          maxFrames: p.num(`Approximate number of frames to sample (default ${DEFAULT_MAX_FRAMES}, max ${MAX_MAX_FRAMES}).`),
        },
        ["path"],
      ),
      async (input, ctx): Promise<string | ToolExecuteResult> => {
        const raw = String(input.path ?? "").trim();
        if (!raw) return "Error: video_keyframes: path is required.";
        const safePath = validateWorkspacePath(raw);
        if (!safePath) return "Error: video_keyframes: path must be a /workspace/... path with no '..' segments.";
        const maxFrames = Math.min(
          MAX_MAX_FRAMES,
          Math.max(MIN_MAX_FRAMES, Math.round(typeof input.maxFrames === "number" ? input.maxFrames : DEFAULT_MAX_FRAMES)),
        );

        const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const outPrefix = `/workspace/.video-keyframes-${runId}-`;
        const command = [
          `DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 ${shellQuote(safePath)})`,
          `INTERVAL=$(python3 -c "d=float('$DURATION' or 0); print(max(d/${maxFrames}, 0.1))")`,
          `ffmpeg -y -loglevel error -i ${shellQuote(safePath)} -vf fps=1/$INTERVAL -vframes ${maxFrames} ${shellQuote(outPrefix + "%03d.jpg")}`,
        ].join(" && ");

        const result = await runCommand({ command, sessionKey: `${ctx.conversationId}:${ctx.agentId}` });
        if (!result.ok) {
          return `Error: video_keyframes: frame extraction failed (exit ${result.exitCode ?? "?"}): ${result.output}`;
        }

        const entries = await vfs.list("/workspace").catch(() => []);
        const framePaths = entries
          .filter((e) => e.type !== "dir" && e.path.startsWith(outPrefix))
          .map((e) => e.path)
          .sort();
        if (framePaths.length === 0) {
          return "Error: video_keyframes: ffmpeg reported success but produced no frames — the video may be unreadable or unsupported.";
        }

        const attachments: Attachment[] = [];
        try {
          for (const framePath of framePaths) {
            const buf = await vfs.readBuffer(framePath);
            attachments.push({ type: "image", mimeType: "image/jpeg", data: buf.toString("base64") });
          }
        } finally {
          await Promise.all(framePaths.map((f) => vfs.remove(f).catch(() => {})));
        }

        return { text: `Extracted ${attachments.length} keyframe(s) from ${safePath}.`, attachments };
      },
    )),
  };
}
