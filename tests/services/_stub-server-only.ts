// Unit-test module-resolution shims. Must be the FIRST import in any test file
// that (transitively) touches src/ — ES import order is preserved as sequential
// requires, so these side effects run before later imports resolve.
//
// Two distinct problems, one `Module._load` patch:
//
// 1. `server-only`. The real package (node_modules/server-only/index.js) throws
//    unconditionally unless resolved under Next's webpack/turbopack
//    "react-server" export condition — which the plain Playwright/Node runner
//    never sets. Every src/core/service/* module starts with
//    `import "server-only"`, so importing them here would otherwise always throw
//    "This module cannot be imported from a Client Component module."
//
// 2. tsconfig `paths` aliases (`@/…`, `#bos-plugin-sdk`). Playwright's TS
//    transform rewrites these, but ONLY across the STATIC import graph it walks
//    from a test file. A module pulled in with a DYNAMIC `await import(…)` is
//    loaded through Node's own resolver instead, which knows nothing about
//    tsconfig — so any `@/…` specifier inside it fails with
//    "Cannot find module '@/os/data-dir'".
//
//    That is not a hypothetical: tests/gitops/conflict-session-store.test.ts and
//    conflict-agent-config.test.ts both `await import("../../src/lib/…")` in
//    order to get a module that re-reads BOS_DATA_DIR, and both were failing
//    (18 tests) purely because of it. The failure is confusing because the same
//    module imports fine from a test that reaches it statically.
//
//    Resolving the aliases here fixes the whole class rather than the two call
//    sites, and keeps tests free to use dynamic import where they need a fresh
//    module. The mapping mirrors tsconfig.json's `paths` exactly — if that ever
//    grows an entry, add it here too.
import Module from "node:module";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** Mirrors tsconfig.json `compilerOptions.paths`. */
const EXACT_ALIASES: Record<string, string> = {
  "#bos-plugin-sdk": path.join(REPO_ROOT, "src", "lib", "bos-plugins", "sdk", "index.ts"),
};
const PREFIX_ALIASES: [string, string][] = [["@/", path.join(REPO_ROOT, "src") + path.sep]];

function resolveAlias(request: string): string | undefined {
  const exact = EXACT_ALIASES[request];
  if (exact) return exact;
  for (const [prefix, target] of PREFIX_ALIASES) {
    if (request.startsWith(prefix)) return target + request.slice(prefix.length);
  }
  return undefined;
}

const moduleInternals = Module as unknown as {
  _load: (request: string, ...rest: unknown[]) => unknown;
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
};

// `server-only` is short-circuited at _load: we want to return a stub OBJECT,
// never to resolve a file at all.
const originalLoad = moduleInternals._load;
moduleInternals._load = function patchedLoad(request: string, ...rest: unknown[]) {
  if (request === "server-only") return {};
  return originalLoad.apply(this, [request, ...rest]);
};

// Aliases are rewritten at _resolveFilename — the same hook tsconfig-paths uses,
// and the one Playwright's own loader routes through. Patching _load instead
// does NOT work: Playwright resolves the specifier before _load sees it, so the
// alias reaches Node untouched.
const originalResolveFilename = moduleInternals._resolveFilename;
moduleInternals._resolveFilename = function patchedResolve(request: string, ...rest: unknown[]) {
  const aliased = resolveAlias(request);
  if (aliased) {
    try {
      return originalResolveFilename.apply(this, [aliased, ...rest]);
    } catch {
      // Fall through to the original specifier so a genuinely missing module
      // still reports its own name rather than a rewritten path.
    }
  }
  return originalResolveFilename.apply(this, [request, ...rest]);
};
