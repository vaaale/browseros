import { promises as fs } from "node:fs";
import path from "node:path";
import { CANONICAL_DATA } from "./config.mjs";
import { slog } from "./log.mjs";
import { state } from "./state.mjs";

// Conversation files live at dataDir()/vfs/Documents/Chats/<id>.json
// (src/os/vfs.ts's CANONICAL_VFS_ROOT — the Chats subtree is always read and
// written against canonical data, base or preview alike).
const CHATS_DIR = path.join(CANONICAL_DATA, "vfs", "Documents", "Chats");

/**
 * Clear `activeFeatureBranch` on every conversation still pointing at a
 * just-promoted (now-deleted) branch.
 *
 * Without this, a conversation left pointing at a branch promote just
 * retired silently recreates a branch of the same name the next time
 * anything resolves its active branch (a dev-harness call, an app install,
 * …) — `_provisionPreview` (preview.mjs) creates one fresh off base when the
 * ref is missing. That reads as "the branch came back" in Settings →
 * Versions, and — before base's home stopped being a feature-branch-shaped
 * path (042-worktree-collision) — could land the resurrected preview on the
 * exact path base itself was still running from.
 *
 * The matching conversations are found by reading their files directly here
 * (read-only, Node built-ins only — the Supervisor does not import src/lib) —
 * but the actual CLEAR is issued through base's own
 * `PATCH /api/assistant/feature-branches`, not a direct file write. Base's
 * agent loop (conversation-store.ts) is the file's real single writer,
 * serialized through its own per-conversation queue; a direct Supervisor
 * write here would be a SECOND, uncoordinated writer of the exact file BOS's
 * own client-vs-agent-loop race was just fixed for (conversations.ts /
 * conversation-store.ts) — racing a live agent turn's own save could revert
 * this clear exactly like that bug, and a plain `fs.writeFile` isn't even
 * atomic (the project's own contract: every store under `data/` must write
 * atomically). Routing through base's API reuses the one place that's
 * actually safe to write this file from, the same way `push.mjs`'s
 * `pushOriginViaBaseApi` reuses base's own git-credential-aware push instead
 * of reimplementing it standalone.
 */
export async function clearActiveFeatureBranch(branch, warnings) {
  let entries;
  try {
    entries = await fs.readdir(CHATS_DIR, { withFileTypes: true });
  } catch (e) {
    if (e?.code !== "ENOENT") {
      const msg = `reading ${CHATS_DIR} failed — activeFeatureBranch was not cleared on any conversation: ${e?.message || e}`;
      slog("error", "promote", msg, { branch });
      if (Array.isArray(warnings)) warnings.push(msg);
    }
    return; // ENOENT: no conversations directory yet — nothing to clear
  }

  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(CHATS_DIR, entry.name);
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      if (parsed?.activeFeatureBranch === branch && typeof parsed.id === "string" && parsed.id) {
        matches.push(parsed.id);
      }
    } catch (e) {
      const msg = `reading ${entry.name} to check its active branch failed: ${e?.message || e}`;
      slog("warn", "promote", msg, { branch });
      if (Array.isArray(warnings)) warnings.push(msg);
    }
  }
  if (!matches.length) return;

  if (!state.base || state.base.state !== "ready" || !state.base.port) {
    const msg = `base is not ready — could not clear activeFeatureBranch on ${matches.length} conversation(s) still pointing at "${branch}"; it may resurrect this branch the next time one of them resolves its active branch`;
    slog("error", "promote", msg, { branch });
    if (Array.isArray(warnings)) warnings.push(msg);
    return;
  }

  for (const conversationId of matches) {
    try {
      const res = await fetch(`http://127.0.0.1:${state.base.port}/api/assistant/feature-branches`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, branch: "" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
    } catch (e) {
      const msg = `clearing activeFeatureBranch on conversation ${conversationId} via base API failed: ${e?.message || e}`;
      slog("warn", "promote", msg, { branch });
      if (Array.isArray(warnings)) warnings.push(msg);
    }
  }
}
