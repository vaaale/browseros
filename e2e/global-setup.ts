import fs from "node:fs";
import path from "node:path";

// Deterministically bypass the first-run wizard so the desktop is interactive
// in tests. This writes the same `setupComplete` flag the wizard sets on
// finish (data/config/system.json, see /api/system/setup), so it is benign.
// NOTE: until BOS supports a separate data dir (DataFS), e2e runs against the
// app's real data dir; the baseline suite is written to be non-destructive.
export default async function globalSetup() {
  const dir = path.join(process.cwd(), "data", "config");
  const file = path.join(dir, "system.json");
  fs.mkdirSync(dir, { recursive: true });
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    /* no existing file */
  }
  if (current.setupComplete !== true) {
    fs.writeFileSync(file, JSON.stringify({ ...current, setupComplete: true }, null, 2), "utf8");
  }
}
