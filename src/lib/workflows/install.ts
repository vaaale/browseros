import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { installApp, listInstalledApps } from "@/lib/apps/store";

const APP_ID = "workflow-manager";
const APP_NAME = "Workflow Manager";
const TEMPLATE = path.join(process.cwd(), "src", "lib", "workflows", "template", "index.html");

let ensured = false;

// Idempotent: installs the Workflow Manager iframe app the first time anyone
// hits /api/workflows. After that the cached `ensured` flag short-circuits.
export async function ensureWorkflowApp(): Promise<void> {
  if (ensured) return;
  const apps = await listInstalledApps();
  if (apps.some((a) => a.id === APP_ID)) {
    ensured = true;
    return;
  }
  const html = await fs.readFile(TEMPLATE, "utf8");
  await installApp({ name: APP_NAME, icon: "Workflow", files: { "index.html": html } });
  ensured = true;
}
