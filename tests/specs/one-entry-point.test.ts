// The structural guard behind a failure this codebase hit four times: a test
// asserting a REACHABLE function instead of the one the product calls.
//
// The cause was never carelessness. It was that the entry point and its helpers
// were equally reachable, and the helper was easier to call — so tests drifted
// to the purest function, and purity is exactly what makes it not the
// integration being claimed.
//
//   npm run test:unit -- tests/specs/one-entry-point.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

test("resolveMethod has exactly ONE product caller", () => {
  // It is the pure binding-chain primitive and takes a binding the CALLER
  // assembles. Three call sites once assembled it differently — one omitted the
  // global default, one omitted the project, none read `workflow` — so BOS
  // resolved a different method depending on which path you arrived through.
  //
  // Everything outside the pipeline goes through methodForStore/defaultMethod.
  // If this fails, a new caller is rebuilding the chain by hand; give it a named
  // question in pipeline.ts instead.
  const offenders = sourceFiles("src")
    .filter((f) => !f.endsWith(join("method", "resolve.ts")))
    .filter((f) => !f.endsWith(join("specs", "pipeline.ts")))
    .filter((f) => /\bresolveMethod\s*\(/.test(readFileSync(f, "utf8")));
  expect(offenders, "assemble the chain in pipeline.ts, not at the call site").toEqual([]);
});

test("an agent is resolved by getAgent, never by searching a listing", () => {
  // getAgent was once implemented over the PICKER listing, which made every
  // delegate-only agent undeliverable while both listings stayed correct in
  // isolation — so a test asserting the listings passed throughout.
  const offenders = sourceFiles("src")
    .filter((f) => !f.endsWith(join("subagents", "store.ts")))
    .filter((f) => {
      const t = readFileSync(f, "utf8");
      return /\b(listSubAgents|listDelegatableAgents)\s*\([^)]*\)\s*\)?\s*\.\s*find\s*\(/.test(t);
    });
  expect(offenders, "use getAgent — a listing is not a lookup").toEqual([]);
});
