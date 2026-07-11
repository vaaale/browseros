import "server-only";
import * as vfs from "@/os/vfs";
import { agentFeedbackScanFile } from "./paths";

// Per-agent "last feedback scan" watermark (thumbs up/down processing). The
// thumbs RATING lives on the message in the client-owned conversation JSON; this
// server-owned sidecar only tracks the timestamp up to which the fast loop has
// already processed feedback, so it never writes into the chat file (which the
// client rewrites continuously) and never re-processes the same rating.

interface ScanState {
  at: number;
}

export async function getFeedbackScanAt(agentId: string): Promise<number> {
  try {
    const raw = await vfs.readText(agentFeedbackScanFile(agentId));
    const parsed = JSON.parse(raw) as Partial<ScanState>;
    return typeof parsed.at === "number" ? parsed.at : 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    return 0;
  }
}

export async function setFeedbackScanAt(agentId: string, at: number): Promise<void> {
  await vfs.writeText(agentFeedbackScanFile(agentId), JSON.stringify({ at }));
}
