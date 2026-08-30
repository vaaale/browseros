import "server-only";
import type { AssistantTool, ToolExecuteResult } from "../../tools";
import { serverTool, parallel, schema, p } from "./util";
import * as vfs from "@/os/vfs";
import { mimeForPath } from "@/lib/mime";

// Lets an agent actually SEE an image (real visual understanding), rather
// than only reading file bytes as text — the multimodal counterpart to
// file_to_markdown for document formats. Used by the OKF ingest sub-agent for
// image sources (040-okf-knowledge-base), but generally useful wherever an
// agent needs to reason about an image's actual content.

const SUPPORTED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_BYTES = 5 * 1024 * 1024;

export function viewImageTools(): Record<string, AssistantTool> {
  return {
    // Pure VFS read — several images can be pulled in at once (e.g. reviewing
    // a set of screenshots). Note this is why view_image exists as its own tool
    // rather than folding image support into video_keyframes: the latter is
    // run_command-backed and must stay sequential.
    view_image: parallel(serverTool(
      "view_image",
      "View an image at a VFS path so you can actually reason about its visual content (not just read bytes as text). Returns the image to you directly as a vision content block. Supports PNG/JPEG/GIF/WebP, up to 5MB.",
      schema({ path: p.str("VFS path to the image, e.g. /workspace/photo.jpg.") }, ["path"]),
      async (input): Promise<string | ToolExecuteResult> => {
        const path = String(input.path ?? "").trim();
        if (!path) return "Error: view_image: path is required.";
        const mimeType = mimeForPath(path);
        if (!SUPPORTED_IMAGE_MIME.has(mimeType)) {
          return `Error: view_image: unsupported or non-image file type (${mimeType}) — supported: ${[...SUPPORTED_IMAGE_MIME].join(", ")}.`;
        }
        let buf: Buffer;
        try {
          buf = await vfs.readBuffer(path);
        } catch (err) {
          return `Error: view_image: could not read ${path}: ${err instanceof Error ? err.message : String(err)}`;
        }
        if (buf.length > MAX_BYTES) {
          return `Error: view_image: ${path} is ${buf.length} bytes, over the ${MAX_BYTES}-byte limit.`;
        }
        return {
          text: `Viewing image: ${path}`,
          attachments: [{ type: "image", mimeType, data: buf.toString("base64"), vfsPath: path }],
        };
      },
    )),
  };
}
