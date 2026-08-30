import "./_stub-server-only";
import { installFixtureService, TOOL_DECLARING_WORKER } from "./_worker-fixtures";

// 039-service-tool-exposure — reusable fixture for a marketplace item whose
// service opts into tool exposure (deploymentMode: "tools") and declares one
// tool at startup. Shared across unit (ServiceToolBridge/ServiceManager),
// integration, and e2e tests so they all install the exact same stub.

export const ECHO_TOOL_NAME = "echo_tool";

export const ECHO_TOOL_DECLARATION = {
  name: ECHO_TOOL_NAME,
  description: "Echoes the given text back",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
};

/** Installs the tool-declaring stub service at dataDir()/system/<id>, opted
 *  into tool exposure via manifest.deploymentMode. Pass `entrySource` to swap
 *  in a different worker script (e.g. one that throws) while keeping the
 *  same opted-in manifest shape. */
export function installToolFixtureService(
  dataDir: string,
  id: string,
  opts: { entrySource?: string; entry?: string } = {},
): void {
  installFixtureService(dataDir, id, {
    entrySource: opts.entrySource ?? TOOL_DECLARING_WORKER,
    entry: opts.entry,
    deploymentMode: "tools",
  });
}
