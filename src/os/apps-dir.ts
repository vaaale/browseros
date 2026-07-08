import "server-only";
import path from "path";

// Root directory for user-installed apps — versioned *content*, not runtime
// state. It is a standalone git repository (GitFS) that lives ALONGSIDE the data
// dir but is independent of the BOS source repo (gitignored here), so that:
//   - app history/branching/sharing is handled by git (marketplace-ready), and
//   - pulling upstream BOS changes never collides with a user's own apps.
//
// Configurable via BOS_APPS_DIR (set it in .env.local), defaulting to
// <cwd>/apps. Kept separate from BOS_DATA_DIR because apps need *proper
// versioning* (git), whereas DataFS state only needs throwaway preview isolation.
export function appsDir(): string {
  const override = process.env.BOS_APPS_DIR;
  return override && override.trim() ? override.trim() : path.join(process.cwd(), "apps");
}
