import { existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import path from "path";
import * as esbuild from "esbuild";

// The multi-process scheduler tests need to run the REAL engine inside separate
// OS processes — that is the whole point: `runningJobIds` and the globalThis
// daemon singleton are per-process, so nothing short of real processes can
// reproduce the N× dispatch bug (042-scheduler-daemon-lock).
//
// Node can't execute the TypeScript sources directly (no ts-node/tsx in this
// repo), so we bundle the child entry with esbuild — already a dependency,
// used the same way the app installer bundles multi-file apps. Two shims are
// needed, both mirroring what tests/services/_stub-server-only.ts does for
// in-process tests: `@/…` path aliases, and a no-op `server-only`.

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function resolveAlias(spec: string): string | null {
  const base = path.join(REPO_ROOT, "src", spec.slice(2));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Bundle a TS entry under tests/ into a runnable CJS file and return its path.
 * `outDir` should be inside the test's own temp tree so parallel workers never
 * fight over the artifact.
 */
export async function bundleForChildProcess(entry: string, outDir: string): Promise<string> {
  mkdirSync(outDir, { recursive: true });
  const stub = path.join(outDir, "server-only-stub.js");
  writeFileSync(stub, "module.exports = {};\n", "utf8");
  const outfile = path.join(outDir, "child.cjs");

  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    logLevel: "silent",
    plugins: [
      {
        name: "bos-test-aliases",
        setup(build) {
          build.onResolve({ filter: /^server-only$/ }, () => ({ path: stub }));
          build.onResolve({ filter: /^@\// }, (args) => {
            const resolved = resolveAlias(args.path);
            return resolved
              ? { path: resolved }
              : { errors: [{ text: `unresolved alias: ${args.path}` }] };
          });
        },
      },
    ],
  });

  return outfile;
}
