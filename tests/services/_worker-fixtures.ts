import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";

// Real worker_threads fixtures rather than mocked Workers — `new Worker(entryPath,
// ...)` in ServiceManager.start() takes a real file path, and validateManifestAtStart
// dynamically `import()`s the SAME file from the main thread first (where
// `parentPort` is null), so every fixture must guard on `parentPort` being set.

export const RESPONSIVE_WORKER = `
const { parentPort } = require("node:worker_threads");
if (parentPort) {
  parentPort.on("message", (msg) => {
    if (msg && msg.type === "initialize") parentPort.postMessage({ type: "initialized" });
    if (msg && msg.type === "dispose") parentPort.postMessage({ type: "disposed" });
  });
}
`;

export const UNRESPONSIVE_WORKER = `
const { parentPort } = require("node:worker_threads");
// Deliberately never responds — used to exercise the startup-timeout path.
if (parentPort) {
  parentPort.on("message", () => {});
}
`;

export const CRASHING_WORKER = `
const { parentPort } = require("node:worker_threads");
if (parentPort) {
  throw new Error("intentional crash for test");
}
`;

/** Lays out dataDir()/system/services/<id>/service.json + <entry> so
 *  ServiceManager.start() can resolve and load a real worker entrypoint. */
export function installFixtureService(
  dataDir: string,
  id: string,
  opts: { entrySource: string; dependencies?: string[]; entry?: string } = { entrySource: RESPONSIVE_WORKER },
): void {
  const entry = opts.entry ?? "index.js";
  const servicesDir = join(dataDir, "system", "services", id);
  mkdirSync(servicesDir, { recursive: true });
  writeFileSync(
    join(servicesDir, "service.json"),
    JSON.stringify({ id, name: id, version: "1.0.0", entry, ...(opts.dependencies ? { dependencies: opts.dependencies } : {}) }),
  );
  writeFileSync(join(servicesDir, entry), opts.entrySource);
}
