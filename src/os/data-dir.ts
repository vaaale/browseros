import "server-only";
import path from "path";

// Root directory for ALL BrowserOS runtime state (VFS, settings, config,
// memory, skills, agents, docs, installed-apps, mcp servers, provider config).
//
// Configurable via BOS_DATA_DIR so the live-version-control feature
// (spec/self-modification/) can run multiple BOS versions: the active version
// uses the canonical data dir, while a previewed candidate is launched with
// BOS_DATA_DIR pointing at an isolated copy-on-write clone. Resolved once at
// module load — each version is its own process with a fixed env.
export function dataDir(): string {
  const override = process.env.BOS_DATA_DIR;
  return override && override.trim() ? override.trim() : path.join(process.cwd(), "data");
}
