// Unit tests for Feature Context id/branch helpers (027-vfs-specfs).
import { test } from "@playwright/test";
import { strict as assert } from "node:assert";
import { sanitizeFeatureId, encodeBranchDir } from "../../src/lib/specs/feature-id";

test("accepts valid ids", () => {
  assert.equal(sanitizeFeatureId("backend-with-ui"), "backend-with-ui");
  assert.equal(sanitizeFeatureId("feat123"), "feat123");
  assert.equal(sanitizeFeatureId("  trimmed-me  "), "trimmed-me");
});

test("rejects invalid ids (injection / traversal surface)", () => {
  for (const bad of ["My Feature", "a/b", "a_b", "", "a..b", "UPPER", "sp ace", "sl/ash"]) {
    assert.throws(() => sanitizeFeatureId(bad), /Invalid feature id/, `expected reject: ${bad}`);
  }
});

test("flat-encodes a slashed branch reversibly", () => {
  assert.equal(encodeBranchDir("bos/my-change"), "bos__my-change");
});
