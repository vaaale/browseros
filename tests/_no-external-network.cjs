// Unit-suite network guard. Preloaded into EVERY Node process of the run
// (including each Playwright worker) via `NODE_OPTIONS=--require` in the
// `test:unit` npm script — deliberately not an import in a test file, because
// only 94 of 127 test files share a common shim and the ones that don't are
// exactly the ones that reach the model layer.
//
// WHY THIS EXISTS
//
// Nothing in src/ short-circuits a model call when no provider is configured:
// `src/lib/agent/llm.ts` builds a client with the literal api key "MISSING"
// and sends the request anyway. So a unit test that reaches runSubAgent makes
// a REAL HTTP request, and which service it hits depends on the machine:
//
//   - `data/provider.json`, if `provider.ts` captured a dataDir() pointing at
//     the developer's real data dir (it computes its FILE path at MODULE
//     scope, before any test redirects BOS_DATA_DIR) — on the machine where
//     this was diagnosed, a LAN LLM server;
//   - otherwise `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` from the ambient
//     environment — for anyone running the suite from a shell that has them
//     set, the real Anthropic API.
//
// That made four self-heal tests non-deterministic in the worst way: they
// "passed" only because an external service happened to reject the request
// quickly, and they timed out at 30s whenever it didn't. With a VALID key
// they would have made real, billable model calls from a unit test.
//
// WHAT IT DOES
//
// Loopback and unix sockets stay allowed — tests legitimately spawn local
// servers and talk to /var/run/docker.sock. Anything else fails immediately
// with a named error instead of hanging, and logs loudly, so a test that
// accidentally reaches for the network is obvious rather than slow.
//
// If a test ever genuinely needs external egress, set
// BOS_TEST_ALLOW_NETWORK=1 for that run rather than weakening this.

// require(), not import: this file is loaded by `node --require`, which only
// accepts CommonJS. It also must patch the module BEFORE any test code runs,
// which an async ESM import could not guarantee.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const net = require("node:net");

const ALLOW = process.env.BOS_TEST_ALLOW_NETWORK === "1";

// Hostnames that never leave the machine. IPv6 loopback appears in several
// spellings; `::ffff:127.0.0.1` is the v4-mapped form Node can hand back.
function isLocal(host) {
  if (!host) return true; // no host ⇒ Node defaults to localhost
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (h.startsWith("::ffff:")) return isLocal(h.slice("::ffff:".length));
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

// net.Socket.prototype.connect is the single funnel for outbound TCP: http,
// https, undici/fetch and the Anthropic/OpenAI SDKs all end up here, and TLS
// sockets inherit it. Blocking at this point also prevents the DNS lookup,
// since the hostname is still a string here.
const originalConnect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function guardedConnect(...args) {
  if (ALLOW) return originalConnect.apply(this, args);

  const first = args[0];
  const options = first !== null && typeof first === "object" && !Array.isArray(first)
    ? first
    : { port: first, host: typeof args[1] === "string" ? args[1] : undefined };

  // Unix domain sockets (e.g. the Docker daemon) never touch the network.
  if (options.path) return originalConnect.apply(this, args);
  if (isLocal(options.host)) return originalConnect.apply(this, args);

  const target = `${options.host}:${options.port}`;
  const err = new Error(
    `Blocked outbound connection to ${target} from a unit test.\n` +
    `The unit suite must be hermetic: no unit test may talk to an external host.\n` +
    `This is almost always an un-stubbed model call — src/lib/agent/llm.ts sends a\n` +
    `request even with no API key configured, so reaching runSubAgent hits a real\n` +
    `provider. Stub the seam instead (e.g. _setAgentLayerForTests,\n` +
    `_setDiagnosticianRunnersForTests, _setSpineAgentHooksForTests).\n` +
    `Override for one run with BOS_TEST_ALLOW_NETWORK=1 if egress is genuinely needed.`,
  );
  err.code = "EPERM_TEST_NETWORK_BLOCKED";

  // Loud, because a caller may well swallow the error: the whole failure mode
  // being removed here is one that hid behind a caught exception.
  console.error(`\n[unit-suite network guard] ${err.message}\n${new Error("connect site").stack}\n`);

  // Surface it the way a refused connection would — asynchronously on the
  // socket — so callers see a normal, FAST connection failure rather than an
  // exception thrown from inside connect(), which some SDKs mishandle.
  process.nextTick(() => {
    this.destroy(err);
  });
  return this;
};
