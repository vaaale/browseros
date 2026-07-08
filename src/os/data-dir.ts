import "server-only";
import path from "path";

// Root directory for BrowserOS runtime state (VFS, settings, config, memory,
// skills, agents, docs, mcp servers, provider config). NOTE: installed apps are
// NOT here — they are versioned content in their own git repo (GitFS), rooted at
// BOS_APPS_DIR (see src/os/apps-dir.ts and specs/007-gitfs/spec.md).
//
// Configurable via BOS_DATA_DIR so the live-version-control feature
// (specs/005-self-modification/) can run multiple BOS versions: the active version
// uses the canonical data dir, while a previewed candidate is launched with
// BOS_DATA_DIR pointing at an isolated copy-on-write clone. Resolved once at
// module load — each version is its own process with a fixed env.
export function dataDir(): string {
  const override = process.env.BOS_DATA_DIR;
  return override && override.trim() ? override.trim() : path.join(process.cwd(), "data");
}
