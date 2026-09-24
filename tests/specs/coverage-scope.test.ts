/**
 * Reproduction:
 *
 *   `npm run test:coverage` reported **99.3% line coverage, 1140/1148 lines** —
 *   over NINE files. `.c8rc.json`'s include list was:
 *
 *       "include": [
 *         "src/os/vfs.ts",
 *         "src/os/mount-table.ts",
 *         "src/os/path-jail.ts",
 *         "src/os/fs/ ** / *.ts"
 *       ]
 *
 *   so the other ~760 TypeScript files BOS ships — every API route, the whole
 *   assistant runtime, the item/spec layers, bastion, the Supervisor — were not
 *   in the report at all. A 99.3% over a scope that narrow does not read as
 *   "nine files are well covered"; it reads as "BOS is covered", which is the
 *   one thing a coverage report exists to tell you the truth about.
 *
 * The contract this locks down: every source file BOS ships that a unit suite
 * can execute is inside the coverage report's scope. Evaluated through
 * `test-exclude` — the exact matcher c8 resolves `include`/`exclude` with — so
 * this test and a real `npm run test:coverage` cannot disagree about a glob.
 *
 * Deliberately NOT asserted here: how much of each file is covered. This is a
 * gate on the report's *scope*, not on a percentage. A file that is in the
 * report at 0% is honest; a file missing from the report is not.
 *
 *   npm run test:unit -- tests/specs/coverage-scope.test.ts
 */
import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// The Playwright runner transpiles this file to CJS, so __filename is the
// anchor for resolving test-exclude (which ships no type declarations).
const requireCjs = createRequire(__filename);
// The same matcher c8 uses to resolve include/exclude (c8 -> test-exclude).
const TestExclude = requireCjs("test-exclude") as new (opts: {
  cwd: string;
  include?: string[];
  exclude?: string[];
  excludeNodeModules?: boolean;
  extension?: string[];
}) => { shouldInstrument(file: string): boolean };

const REPO_ROOT = path.resolve(__dirname, "..", "..");

/**
 * The trees that make up BOS itself, with the suite that executes each:
 *
 *   src/            the OS — run by `npm run test:unit` (tests/ ** / *.test.ts)
 *   bastion/src/    the multi-user Docker front door — also by test:unit
 *                   (tests/bastion/*.test.ts import bastion/src directly)
 *   tools/supervisor/  live version control — by `node --test tests/supervisor/`
 *
 * Out of scope on purpose: `tools/*.mjs` and `scripts/*.mjs` are build-time
 * generators and operator one-shots, not BOS at runtime, and no suite executes
 * them. If that changes, add the tree here first and watch this test fail.
 */
const SOURCE_TREES: ReadonlyArray<{ dir: string; extensions: string[] }> = [
  { dir: "src", extensions: [".ts", ".tsx"] },
  { dir: path.join("bastion", "src"), extensions: [".ts"] },
  { dir: path.join("tools", "supervisor"), extensions: [".mjs"] },
];

/** Generated at predev/prebuild by tools/gen-apps.mjs; gitignored, not authored. */
const GENERATED = new Set([
  path.join("src", "apps", "_manifests.generated.ts"),
  path.join("src", "apps", "_components.generated.ts"),
]);

function walk(dir: string, extensions: string[], out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(rel, extensions, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (rel.endsWith(".d.ts") || rel.endsWith(".test.ts")) continue;
    if (GENERATED.has(rel)) continue;
    if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(rel);
  }
  return out;
}

function matcher() {
  const config = JSON.parse(readFileSync(path.join(REPO_ROOT, ".c8rc.json"), "utf8")) as {
    include?: string[];
    exclude?: string[];
    extension?: string[];
  };
  return new TestExclude({
    cwd: REPO_ROOT,
    include: config.include,
    exclude: config.exclude,
    extension: config.extension,
  });
}

test("every BOS source file is inside the coverage report's scope", () => {
  const exclude = matcher();
  const missing: string[] = [];

  for (const tree of SOURCE_TREES) {
    for (const file of walk(tree.dir, tree.extensions)) {
      if (!exclude.shouldInstrument(path.join(REPO_ROOT, file))) missing.push(file);
    }
  }

  expect(
    missing.sort(),
    `${missing.length} source file(s) are outside .c8rc.json's include/exclude globs, so ` +
      `npm run test:coverage reports a percentage that silently excludes them.`,
  ).toEqual([]);
});

test("each BOS source tree contributes files to the coverage scope", () => {
  // Guards the test above against a vacuous pass: if a tree ever walks to zero
  // files (a rename, a moved directory), "nothing is missing" is meaningless.
  const exclude = matcher();

  for (const tree of SOURCE_TREES) {
    const files = walk(tree.dir, tree.extensions);
    expect(files.length, `${tree.dir} walked to zero source files`).toBeGreaterThan(0);
    expect(
      files.filter((f) => exclude.shouldInstrument(path.join(REPO_ROOT, f))).length,
      `${tree.dir} contributes no files to the coverage report`,
    ).toBeGreaterThan(0);
  }
});

test("coverage scope excludes tests, type declarations and generated code", () => {
  const exclude = matcher();
  const notSource = [
    path.join("tests", "specs", "coverage-scope.test.ts"),
    path.join("src", "os", "types.d.ts"),
    ...GENERATED,
  ];

  for (const file of notSource) {
    expect(
      exclude.shouldInstrument(path.join(REPO_ROOT, file)),
      `${file} is not authored source and must stay out of the report`,
    ).toBe(false);
  }
});
