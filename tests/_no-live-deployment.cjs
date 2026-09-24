// Unit-suite live-deployment guard. Preloaded into EVERY Node process of the
// run (including each Playwright worker) via `NODE_OPTIONS=--require` in the
// `test:unit` npm script, alongside `_no-external-network.cjs`.
//
// WHY THIS EXISTS
//
// The unit suite can be run INSIDE a live BOS. A self-modifying agent running
// `npm run test:unit` on its own initiative is a normal thing for this product
// to do, and every Supervisor-managed BOS process is launched with the live
// deployment's coordinates in its environment
// (tools/supervisor/lib/base.mjs, proc.mjs):
//
//     BOS_SUPERVISOR_URL=http://127.0.0.1:<public port>
//     BOS_REPO / BOS_WORKTREES / BOS_DATA_CLONES
//
// A child process inherits all of it. `src/lib/devharness/supervisor.ts` gates
// on nothing but the presence of BOS_SUPERVISOR_URL, so a test that writes a
// spec on a feature branch POSTs to the LIVE Supervisor's
// `/__supervisor/begin` — which creates a real branch, a real worktree and a
// real data clone in the running deployment.
//
// That is not hypothetical. A production box was found carrying 21 `bos/*`
// branches, 18 of which are fixture names straight out of this suite
// (`bos/history`, `bos/lifecycle-test`, `bos/project-layer`, `bos/core-change`,
// `bos/follow-the-money`, `bos/from-the-picker`, …), each with a data clone
// that was a full copy of the user's data dir. On a developer machine nothing
// is listening on the control port, so the suite looks perfectly hermetic and
// the leak only ever appears in production. `tests/services/_test-env.ts`
// documents the same shape for BOS_SPECS_ROOT (~50 stray projects in a live
// spec store) and for BOS_CANONICAL_DATA (corrupt conversation fixtures in a
// real data dir).
//
// WHAT IT DOES
//
// 1. Clears the AMBIENT values, so nothing resolves the live deployment by
//    accident. A test that genuinely wants a Supervisor sets
//    BOS_SUPERVISOR_URL to its own fake and restores it afterwards
//    (tests/self-heal/integration-partial-build.test.ts, edge-branches.test.ts)
//    — that keeps working, because an explicit fixture is not an inherited
//    production URL.
// 2. Refuses any request to the control plane AT THE INHERITED ORIGIN.
//    Clearing an env var only helps until some module re-sets it or captured
//    it at import time. Scoping the block to the origin that was inherited is
//    what keeps it honest: a test that stands up its OWN fake Supervisor on an
//    ephemeral port is a fixture and must keep working, while the one origin
//    that is definitely a live deployment stays unreachable. With nothing
//    inherited — a developer machine — nothing is blocked, because there is no
//    live deployment to protect.
//
// See tests/specs/unit-suite-never-reaches-live-supervisor.test.ts, which
// exercises this from a CHILD process because the bug only exists across the
// process boundary this guard is installed at.

// Deployment coordinates that must never be inherited. BOS_DATA_DIR /
// BOS_CANONICAL_DATA / BOS_SPECS_ROOT are deliberately NOT in this list:
// clearing them makes dataDir() fall back to `<cwd>/data`, which inside a
// deployment is the very directory we are trying to protect. Those are pinned
// per test by tests/services/_test-env.ts instead.
const LIVE_DEPLOYMENT_VARS = ["BOS_SUPERVISOR_URL", "BOS_REPO", "BOS_WORKTREES", "BOS_DATA_CLONES"];

// Captured BEFORE the delete, because it is the one origin we know belongs to
// a running deployment rather than to a test's own fixture.
const INHERITED_SUPERVISOR_ORIGIN = (() => {
  const raw = process.env.BOS_SUPERVISOR_URL;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    // Unparseable: nothing can match it, so there is nothing to block. The
    // env var still gets cleared below, which is the protection that matters.
    return null;
  }
})();

for (const name of LIVE_DEPLOYMENT_VARS) {
  if (process.env[name] !== undefined) {
    console.warn(`[test-guard] ignoring inherited ${name} — the unit suite must not address a live deployment`);
    delete process.env[name];
  }
}

const CONTROL_PREFIX = "/__supervisor/";

function urlOf(input) {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && typeof input.url === "string") return input.url;
  if (input) return String(input);
  return "";
}

function isLiveControlPlane(input) {
  if (!INHERITED_SUPERVISOR_ORIGIN) return false;
  try {
    const url = new URL(urlOf(input), "http://127.0.0.1");
    return url.origin === INHERITED_SUPERVISOR_ORIGIN && url.pathname.startsWith(CONTROL_PREFIX);
  } catch {
    // Not a parseable URL, so it cannot be addressing the inherited origin.
    // Whatever it is, fetch itself is the right thing to complain about it.
    return false;
  }
}

const realFetch = globalThis.fetch;
globalThis.fetch = function guardedFetch(input, init) {
  if (isLiveControlPlane(input)) {
    const err = new Error(
      "BOS test guard: refusing to call the LIVE Supervisor control plane at " +
        `${INHERITED_SUPERVISOR_ORIGIN} from the unit suite. Reaching it creates real branches, worktrees and ` +
        "data clones in a running deployment (this is how 18 fixture-named bos/* branches ended up in production). " +
        "Stub the seam, or stand up your own fake Supervisor and point BOS_SUPERVISOR_URL at that.",
    );
    err.code = "BOS_TEST_SUPERVISOR_BLOCKED";
    return Promise.reject(err);
  }
  return realFetch.call(this, input, init);
};
