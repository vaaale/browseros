// Shared fixture: a fake Next.js-server stand-in used to let proc.mjs/
// base.mjs/build.mjs/preview.mjs/control.mjs tests reach real "ready" states
// (startProc/waitHealthy) without a real Next.js install. The same script
// body is used two ways:
//  - as a fake `npx` binary (PATH-prepended) — proc.mjs's startProc always
//    spawns `npx next start -p <port>` directly, with no indirection point
//    to override, so intercepting `npx` itself is the only lever.
//  - as base's own `npm run dev` script (package.json's "dev" — `npm run
//    dev -- -p <port>` appends `-p <port>` as extra args to whatever "dev"
//    runs, so pointing "dev" at `node <this file>` reaches the identical
//    argv shape).
// It answers GET /api/health with {ok:true} (matching proc.mjs's
// waitHealthy) unless FAKE_SERVER_UNHEALTHY=1 is set in its env, in which
// case it accepts the TCP connection (so probeOnce sees the port as
// occupied) but never answers health checks.
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";

const FAKE_SERVER_BODY = `#!/usr/bin/env node
import http from "node:http";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("-p") + 1]);
const server = http.createServer((req, res) => {
  if (req.url === "/api/health") {
    if (process.env.FAKE_SERVER_UNHEALTHY === "1") { req.socket.destroy(); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok");
});
server.listen(port, "127.0.0.1");
// FAKE_SERVER_EXITS_AFTER_MS: become ready, then die on our own — what a real
// preview did when an installed item's entrypoint called process.exit(0) in
// BOS's own thread. Health then never succeeds, and the reason must be the
// EXIT, not a timeout that never elapsed.
if (process.env.FAKE_SERVER_EXITS_AFTER_MS) {
  setTimeout(() => process.exit(0), Number(process.env.FAKE_SERVER_EXITS_AFTER_MS));
}
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
`;

export function writeFakeServerScript(destPath) {
  writeFileSync(destPath, FAKE_SERVER_BODY);
  chmodSync(destPath, 0o755);
  return destPath;
}

/** Prepends a directory containing a fake `npx` to PATH so proc.mjs's
 *  `spawn("npx", ["next", "start", "-p", port])` finds it before any real
 *  npx. Returns { bin, restore }. */
export function installFakeNpx() {
  const bin = mkdtempSync(join(tmpdir(), "fake-npx-bin-"));
  writeFakeServerScript(join(bin, "npx"));
  const original = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${original}`;
  return { bin, restore: () => { process.env.PATH = original; } };
}
