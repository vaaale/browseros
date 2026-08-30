import { join } from "path";
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from "fs";

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

// 039-service-tool-exposure — a stub service that opts into tool exposure
// (manifest deploymentMode: "tools"): declares a single "echo_tool" right
// after reporting "initialized", then answers tool_call with tool_result
// (valid string "text" arg) or tool_error (anything else). Mirrors the
// tool_declare/tool_call/tool_result/tool_error IPC contract added to
// src/core/service/types.ts (T002).
export const TOOL_DECLARING_WORKER = `
const { parentPort } = require("node:worker_threads");
if (parentPort) {
  parentPort.on("message", (msg) => {
    if (!msg) return;
    if (msg.type === "initialize") {
      parentPort.postMessage({ type: "initialized" });
      parentPort.postMessage({
        type: "tool_declare",
        payload: {
          callId: "declare-echo_tool",
          declaration: {
            name: "echo_tool",
            description: "Echoes the given text back",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        },
      });
    }
    if (msg.type === "dispose") {
      parentPort.postMessage({ type: "disposed" });
    }
    if (msg.type === "tool_call") {
      const { callId, name, args } = msg.payload;
      // Logged so integration tests can prove a schema-rejected call in the
      // kernel never reaches this worker at all (039-service-tool-exposure T018).
      parentPort.postMessage({ type: "log", level: "info", message: "tool_call received: " + name });
      if (name === "echo_tool" && args && typeof args.text === "string") {
        parentPort.postMessage({ type: "tool_result", payload: { callId, result: args.text } });
      } else {
        parentPort.postMessage({
          type: "tool_error",
          payload: { callId, error: { code: "bad_args", message: "echo_tool requires a string text argument" } },
        });
      }
    }
  });
}
`;

/** Lays out dataDir()/system/services/<id>/service.json + <entry> so
 *  ServiceManager.start() can resolve and load a real worker entrypoint. */
export function installFixtureService(
  dataDir: string,
  id: string,
  opts: { entrySource: string; dependencies?: string[]; entry?: string; deploymentMode?: "default" | "tools" } = {
    entrySource: RESPONSIVE_WORKER,
  },
): void {
  const entry = opts.entry ?? "index.js";
  // 035-install-by-symlink: installed state is ONE symlink, dataDir()/system/<id>,
  // pointing at the item. ServiceManager resolves the entrypoint through it, so a
  // fixture has to be a real item plus that link — not a `system/services/<id>`
  // directory, which is the pre-035 shape and no longer resolves.
  const itemDir = join(dataDir, "user-apps", "items", id);
  const servicesDir = join(itemDir, "services");
  mkdirSync(servicesDir, { recursive: true });
  writeFileSync(
    join(servicesDir, "service.json"),
    JSON.stringify({
      id,
      name: id,
      version: "1.0.0",
      entry,
      ...(opts.dependencies ? { dependencies: opts.dependencies } : {}),
      ...(opts.deploymentMode ? { deploymentMode: opts.deploymentMode } : {}),
    }),
  );
  writeFileSync(join(servicesDir, entry), opts.entrySource);

  const link = join(dataDir, "system", id);
  mkdirSync(join(dataDir, "system"), { recursive: true });
  rmSync(link, { force: true });
  symlinkSync(itemDir, link, "dir");
}

/** An installed item whose service.json exists but whose entry file does NOT —
 *  for testing that manifest validation refuses to start it. */
export function installBrokenFixtureService(dataDir: string, id: string, manifest: object): void {
  const itemDir = join(dataDir, "user-apps", "items", id);
  mkdirSync(join(itemDir, "services"), { recursive: true });
  writeFileSync(join(itemDir, "services", "service.json"), JSON.stringify(manifest));
  const link = join(dataDir, "system", id);
  mkdirSync(join(dataDir, "system"), { recursive: true });
  rmSync(link, { force: true });
  symlinkSync(itemDir, link, "dir");
}
