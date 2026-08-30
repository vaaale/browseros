import { test, expect } from "@playwright/test";
import { strict as assert } from "node:assert";

// Server-only stub must be loaded before any module that imports it.
// Playwright test runner loads modules via its own TS transpiler; we mock
// server-only via module alias in the config.
import {
  _sanitizeUrl,
  _redactSensitiveStrings,
  _throwIfSensitive,
  _CONSOLE_LEVELS_SET,
  _LEVEL_ORDER,
  type GitLogEntry,
} from "../../src/lib/gitops/logging";

test.describe("GitLogger URL sanitization", () => {
  test("strips credentials from URLs with user:pass@", () => {
    expect(_sanitizeUrl("https://user:pass@github.com/x/y.git")).toBe(
      "https://****@github.com/x/y.git",
    );
  });

  test("strips credentials from HTTP URLs", () => {
    expect(_sanitizeUrl("http://admin:secret123@gitlab.com/repo.git")).toBe(
      "http://****@gitlab.com/repo.git",
    );
  });

  test("leaves clean URLs unchanged", () => {
    expect(_sanitizeUrl("https://github.com/x/y.git")).toBe(
      "https://github.com/x/y.git",
    );
  });

  test("leaves SSH URLs unchanged", () => {
    expect(_sanitizeUrl("git@github.com:user/repo.git")).toBe(
      "git@github.com:user/repo.git",
    );
  });

  test("leaves non-URL strings unchanged", () => {
    expect(_sanitizeUrl("hello world")).toBe("hello world");
  });
});

test.describe("GitLogger sensitive data redaction", () => {
  test("redacts sensitive keys in flat objects", () => {
    const result = _redactSensitiveStrings({ token: "abc123", name: "test" }) as Record<string, unknown>;
    expect(result.token).toBe("[REDACTED]");
    expect(result.name).toBe("test");
  });

  test("redacts all known sensitive key names", () => {
    const sensitive = {
      accessToken: "tok",
      pat: "pat",
      sshKeyData: "key",
      passphrase: "pass",
      secret: "sec",
    };
    const result = _redactSensitiveStrings(sensitive) as Record<string, unknown>;
    for (const key of Object.keys(sensitive)) {
      expect(result[key]).toBe("[REDACTED]");
    }
  });

  test("sanitizes URLs in nested objects", () => {
    const result = _redactSensitiveStrings({
      url: "https://user:pass@host.com/repo.git",
    }) as Record<string, unknown>;
    expect(result.url).toBe("https://****@host.com/repo.git");
  });

  test("handles arrays", () => {
    const result = _redactSensitiveStrings([
      "https://user:pass@host.com",
      "plain text",
    ]) as string[];
    expect(result[0]).toBe("https://****@host.com");
    expect(result[1]).toBe("plain text");
  });

  test("handles non-string, non-object values", () => {
    const result = _redactSensitiveStrings(42) as number;
    expect(result).toBe(42);
  });
});

test.describe("GitLogger sensitive detection (throwIfSensitive)", () => {
  test("allows normal log entries", () => {
    assert.doesNotThrow(() =>
      _throwIfSensitive({ op: "test", repoPath: "/tmp/repo" }),
    );
  });

  test("allows empty entry", () => {
    assert.doesNotThrow(() => _throwIfSensitive({ op: "test" }));
  });

  test("rejects entries with token in sensitive field", () => {
    assert.throws(
      () =>
        _throwIfSensitive({
          op: "test",
          accessToken: "ghp_abc123",
        } as GitLogEntry),
      /sensitive field/,
    );
  });

  test("rejects entries with PAT in sensitive field", () => {
    assert.throws(
      () =>
        _throwIfSensitive({
          op: "test",
          pat: "glpat-xxxx",
        } as GitLogEntry),
      /sensitive field/,
    );
  });

  test("rejects entries with SSH key data in sensitive field", () => {
    assert.throws(
      () =>
        _throwIfSensitive({
          op: "test",
          sshKeyData: "-----BEGIN OPENSSH PRIVATE KEY-----",
        } as GitLogEntry),
      /sensitive field/,
    );
  });

  test("rejects entries with passphrase in sensitive field", () => {
    assert.throws(
      () =>
        _throwIfSensitive({
          op: "test",
          passphrase: "my-secret",
        } as GitLogEntry),
      /sensitive field/,
    );
  });
});

test.describe("GitLogger log levels", () => {
  test("has all 5 levels in order", () => {
    expect(_LEVEL_ORDER).toEqual([
      "debug",
      "info",
      "warn",
      "error",
      "critical",
    ]);
  });

  test("console levels include warn, error, critical", () => {
    expect(_CONSOLE_LEVELS_SET.has("warn")).toBe(true);
    expect(_CONSOLE_LEVELS_SET.has("error")).toBe(true);
    expect(_CONSOLE_LEVELS_SET.has("critical")).toBe(true);
    expect(_CONSOLE_LEVELS_SET.has("debug")).toBe(false);
    expect(_CONSOLE_LEVELS_SET.has("info")).toBe(false);
  });
});
