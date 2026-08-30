// Unit tests for src/lib/marketplace/item-manifest.ts — the standalone,
// read-only manifest lookup extracted from marketplace/client.ts specifically
// to break a circular import (item-stores.test.ts covers the discovery side;
// this file covers getItemDisplayName/getItemOriginLabel directly, including
// their fallback paths, which nothing else exercises).
//   npm run test:unit -- tests/specs/item-manifest.test.ts
import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { useTestDataDir } from "../services/_test-env";
import { getItemDisplayName, getItemOriginLabel } from "../../src/lib/marketplace/item-manifest";
import type { InstalledItem } from "../../src/system/items/installed";

function fakeItem(overrides: Partial<InstalledItem>): InstalledItem {
  return {
    id: "widget",
    itemPath: "/nonexistent",
    facets: { app: false, service: false, plugin: false, spec: true, hooks: false },
    origin: "local",
    broken: false,
    ...overrides,
  };
}

test("getItemDisplayName falls back to a title-cased id when no manifest exists yet", async () => {
  const { cleanup } = useTestDataDir("item-manifest-no-file");
  try {
    const name = await getItemDisplayName(fakeItem({ id: "my-cool-widget" }));
    expect(name).toBe("My Cool Widget");
  } finally {
    cleanup();
  }
});

test("getItemDisplayName falls back gracefully on malformed manifest JSON", async () => {
  const { dir, cleanup } = useTestDataDir("item-manifest-malformed");
  try {
    mkdirSync(join(dir, "user-apps"), { recursive: true });
    writeFileSync(join(dir, "user-apps", "marketplace.json"), "{ not valid json ][");
    const name = await getItemDisplayName(fakeItem({ id: "widget" }));
    expect(name).toBe("Widget");
  } finally {
    cleanup();
  }
});

test("getItemDisplayName resolves the real name from an existing manifest", async () => {
  const { dir, cleanup } = useTestDataDir("item-manifest-resolved");
  try {
    mkdirSync(join(dir, "user-apps"), { recursive: true });
    writeFileSync(
      join(dir, "user-apps", "marketplace.json"),
      JSON.stringify({
        id: "user-apps",
        name: "My Apps",
        version: "1.0.0",
        items: [{ id: "widget", name: "The Widget", spec: { path: "items/widget/spec", version: "1.0.0" } }],
      }),
    );
    const name = await getItemDisplayName(fakeItem({ id: "widget" }));
    expect(name).toBe("The Widget");
  } finally {
    cleanup();
  }
});

test("getItemOriginLabel: local origin is always \"local\"", async () => {
  const { cleanup } = useTestDataDir("item-origin-local");
  try {
    expect(await getItemOriginLabel(fakeItem({ origin: "local" }))).toBe("local");
  } finally {
    cleanup();
  }
});

test("getItemOriginLabel: marketplace origin with no marketplaceId (untrusted-symlink fallback) is \"unknown\", never \"local\"", async () => {
  const { cleanup } = useTestDataDir("item-origin-unknown");
  try {
    expect(await getItemOriginLabel(fakeItem({ origin: "marketplace", marketplaceId: undefined }))).toBe("unknown");
  } finally {
    cleanup();
  }
});

test("getItemOriginLabel: marketplace origin falls back to the raw id when the marketplace manifest can't be read", async () => {
  const { cleanup } = useTestDataDir("item-origin-unreadable");
  try {
    expect(await getItemOriginLabel(fakeItem({ origin: "marketplace", marketplaceId: "acme" }))).toBe("acme");
  } finally {
    cleanup();
  }
});
