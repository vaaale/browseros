// auth-scope: hasSessionScope / isLoopbackOnly — consumers of Bastion's
// trusted x-bos-auth-scope claim (see bastion/src/proxy.ts and
// bastion/tests/bastion/proxy-headless-auth.test.ts for the claim's own
// propagation/anti-spoofing tests; this file only covers how a route
// consumes it once it's arrived).
//   npx playwright test -c playwright.unit.config.ts tests/services/auth-scope.test.ts
import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import type { NextRequest } from "next/server";
import { hasSessionScope, isLoopbackOnly, multiUserMode } from "../../src/lib/secrets/auth-scope";

function makeReq(scopeHeader?: string): NextRequest {
  return {
    headers: {
      get(name: string) {
        return name.toLowerCase() === "x-bos-auth-scope" ? (scopeHeader ?? null) : null;
      },
    },
  } as unknown as NextRequest;
}

test.describe("auth-scope", () => {
  test("multiUserMode reflects BOS_PUBLIC_PORT presence", () => {
    const original = process.env.BOS_PUBLIC_PORT;
    try {
      delete process.env.BOS_PUBLIC_PORT;
      expect(multiUserMode()).toBe(false);
      process.env.BOS_PUBLIC_PORT = "8090";
      expect(multiUserMode()).toBe(true);
    } finally {
      if (original === undefined) delete process.env.BOS_PUBLIC_PORT;
      else process.env.BOS_PUBLIC_PORT = original;
    }
  });

  test.describe("behind a Supervisor/Bastion (BOS_PUBLIC_PORT set)", () => {
    const original = process.env.BOS_PUBLIC_PORT;
    test.beforeEach(() => {
      process.env.BOS_PUBLIC_PORT = "8090";
    });
    test.afterEach(() => {
      if (original === undefined) delete process.env.BOS_PUBLIC_PORT;
      else process.env.BOS_PUBLIC_PORT = original;
    });

    test("hasSessionScope is true only for scope === 'session'", () => {
      expect(hasSessionScope(makeReq("session"))).toBe(true);
      expect(hasSessionScope(makeReq("secret:webdav-vfs-mount"))).toBe(false);
      expect(hasSessionScope(makeReq(undefined))).toBe(false);
    });

    test("isLoopbackOnly is true only when the scope header is entirely absent", () => {
      expect(isLoopbackOnly(makeReq(undefined))).toBe(true);
      expect(isLoopbackOnly(makeReq("session"))).toBe(false);
      expect(isLoopbackOnly(makeReq("secret:webdav-vfs-mount"))).toBe(false);
    });

    test("a per-service secret never satisfies hasSessionScope, regardless of which service", () => {
      expect(hasSessionScope(makeReq("secret:any-other-service"))).toBe(false);
    });
  });

  test.describe("standalone (no Supervisor/Bastion, BOS_PUBLIC_PORT unset)", () => {
    const original = process.env.BOS_PUBLIC_PORT;
    test.beforeEach(() => {
      delete process.env.BOS_PUBLIC_PORT;
    });
    test.afterEach(() => {
      if (original === undefined) delete process.env.BOS_PUBLIC_PORT;
      else process.env.BOS_PUBLIC_PORT = original;
    });

    test("both checks are permissive — single local user, nothing to gate", () => {
      expect(hasSessionScope(makeReq(undefined))).toBe(true);
      expect(isLoopbackOnly(makeReq(undefined))).toBe(true);
      // Even a stray/forged header can't matter here — there's no multi-user
      // boundary to protect in the first place.
      expect(hasSessionScope(makeReq("secret:whatever"))).toBe(true);
    });
  });
});
