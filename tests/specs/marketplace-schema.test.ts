// Unit tests for marketplace schema + URL validation (028) — the security-
// critical boundary (untrusted git URLs + untrusted marketplace.json).
import { test } from "@playwright/test";
import { strict as assert } from "node:assert";
import { validateMarketplaceUrl, validateManifest } from "../../src/lib/marketplace/schema";

test("URL allowlist: accepts https and ssh", () => {
  assert.equal(validateMarketplaceUrl("https://github.com/x/y"), "https://github.com/x/y");
  assert.equal(validateMarketplaceUrl("git@github.com:x/y.git"), "git@github.com:x/y.git");
});

test("URL allowlist: rejects dangerous transports", () => {
  for (const bad of ["ext::sh -c whoami", "file:///etc/passwd", "/tmp/repo", "http://x/y", "ftp://x", ""]) {
    assert.throws(() => validateMarketplaceUrl(bad), /Refused|required/, `expected reject: ${bad}`);
  }
});

test("URL allowlist: allows local only when opted in (dev)", () => {
  assert.equal(validateMarketplaceUrl("/tmp/repo", { allowLocal: true }), "/tmp/repo");
  assert.equal(validateMarketplaceUrl("file:///tmp/repo", { allowLocal: true }), "file:///tmp/repo");
  assert.throws(() => validateMarketplaceUrl("ext::x", { allowLocal: true }), /Refused/);
});

test("manifest: accepts a valid manifest", () => {
  const m = validateManifest({
    id: "mk",
    name: "MK",
    version: "1.0.0",
    items: [
      { id: "a", name: "A", app: { entrypoint: "items/a/app", runtime: "iframe", version: "1" } },
      { id: "b", name: "B", spec: { path: "items/b/spec", version: "1" } },
    ],
  });
  assert.equal(m.items.length, 2);
  assert.equal(m.items[0].app?.entrypoint, "items/a/app");
});

test("manifest: rejects malformed / hostile inputs", () => {
  assert.throws(() => validateManifest(null), /not an object/);
  assert.throws(() => validateManifest({ id: "bad id", name: "x", version: "1", items: [] }), /invalid `id`/);
  assert.throws(() => validateManifest({ id: "m", name: "x", version: "1", items: "no" }), /items/);
  // item with neither app nor spec
  assert.throws(
    () => validateManifest({ id: "m", name: "x", version: "1", items: [{ id: "a", name: "A" }] }),
    /app and\/or a spec/,
  );
  // spec path traversal
  assert.throws(
    () =>
      validateManifest({
        id: "m", name: "x", version: "1",
        items: [{ id: "a", name: "A", spec: { path: "../../etc", version: "1" } }],
      }),
    /invalid spec.path/,
  );
  // absolute app entrypoint
  assert.throws(
    () =>
      validateManifest({
        id: "m", name: "x", version: "1",
        items: [{ id: "a", name: "A", app: { entrypoint: "/abs", runtime: "iframe", version: "1" } }],
      }),
    /invalid app.entrypoint/,
  );
});
