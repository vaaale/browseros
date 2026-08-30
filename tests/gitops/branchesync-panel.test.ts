import { test, expect } from "@playwright/test";

interface SyncStatusEntry {
  remoteName: string;
  branch: string;
  localAhead: number;
  localBehind: number;
  hasUncommittedChanges: boolean;
  conflict: boolean | null;
  lastFetched: string | null;
  lastSynced: string | null;
}

function statusColor(s: SyncStatusEntry): string {
  if (s.conflict) return "text-red-400";
  if (s.localAhead > 0 && s.localBehind > 0) return "text-orange-400";
  if (s.localBehind > 0) return "text-amber-400";
  // Nothing blocking and no risk of losing work either way: in sync
  // (nothing to push) or ahead-only (safe to push) are both "healthy".
  return "text-emerald-400";
}

function statusLabel(s: SyncStatusEntry): string {
  if (s.conflict) return "Conflict";
  if (s.localAhead > 0 && s.localBehind > 0) return "Diverged";
  if (s.localBehind > 0) return "Behind";
  if (s.localAhead === 0 && s.localBehind === 0) return "In sync";
  return "Ahead";
}

function aheadBehindText(s: SyncStatusEntry): string {
  const parts: string[] = [];
  if (s.localAhead > 0) parts.push(`${s.localAhead} ahead`);
  if (s.localBehind > 0) parts.push(`${s.localBehind} behind`);
  if (parts.length === 0) return "Up to date";
  return parts.join(", ");
}

test.describe("BranchSyncPanel status helpers", () => {
  test("in-sync status shows correct color and label", () => {
    const status: SyncStatusEntry = {
      remoteName: "upstream",
      branch: "main",
      localAhead: 0,
      localBehind: 0,
      hasUncommittedChanges: false,
      conflict: null,
      lastFetched: "2025-06-01T00:00:00.000Z",
      lastSynced: "2025-06-01T00:00:00.000Z",
    };
    expect(statusColor(status)).toBe("text-emerald-400");
    expect(statusLabel(status)).toBe("In sync");
    expect(aheadBehindText(status)).toBe("Up to date");
  });

  test("behind status shows correct color and label", () => {
    const status: SyncStatusEntry = {
      remoteName: "upstream",
      branch: "main",
      localAhead: 0,
      localBehind: 3,
      hasUncommittedChanges: false,
      conflict: null,
      lastFetched: "2025-06-01T00:00:00.000Z",
      lastSynced: null,
    };
    expect(statusColor(status)).toBe("text-amber-400");
    expect(statusLabel(status)).toBe("Behind");
    expect(aheadBehindText(status)).toBe("3 behind");
  });

  test("ahead status shows correct color and label", () => {
    const status: SyncStatusEntry = {
      remoteName: "upstream",
      branch: "feature",
      localAhead: 5,
      localBehind: 0,
      hasUncommittedChanges: false,
      conflict: null,
      lastFetched: "2025-06-01T00:00:00.000Z",
      lastSynced: "2025-06-01T00:00:00.000Z",
    };
    expect(statusColor(status)).toBe("text-emerald-400");
    expect(statusLabel(status)).toBe("Ahead");
    expect(aheadBehindText(status)).toBe("5 ahead");
  });

  test("diverged status shows correct color and label", () => {
    const status: SyncStatusEntry = {
      remoteName: "upstream",
      branch: "main",
      localAhead: 5,
      localBehind: 2,
      hasUncommittedChanges: false,
      conflict: true,
      lastFetched: "2025-06-01T00:00:00.000Z",
      lastSynced: "2025-06-01T00:00:00.000Z",
    };
    expect(statusColor(status)).toBe("text-red-400");
    expect(statusLabel(status)).toBe("Conflict");
    expect(aheadBehindText(status)).toBe("5 ahead, 2 behind");
  });

  test("diverged without conflict shows orange", () => {
    const status: SyncStatusEntry = {
      remoteName: "upstream",
      branch: "main",
      localAhead: 3,
      localBehind: 1,
      hasUncommittedChanges: false,
      conflict: false,
      lastFetched: "2025-06-01T00:00:00.000Z",
      lastSynced: null,
    };
    expect(statusColor(status)).toBe("text-orange-400");
    expect(statusLabel(status)).toBe("Diverged");
  });
});

test.describe("BranchSyncPanel interface shape", () => {
  test("status has all required fields", () => {
    const status: SyncStatusEntry = {
      remoteName: "origin",
      branch: "main",
      localAhead: 0,
      localBehind: 0,
      hasUncommittedChanges: false,
      conflict: null,
      lastFetched: null,
      lastSynced: null,
    };
    expect(status.remoteName).toBe("origin");
    expect(status.branch).toBe("main");
    expect(status.localAhead).toBe(0);
    expect(status.localBehind).toBe(0);
    expect(status.hasUncommittedChanges).toBe(false);
    expect(status.conflict).toBeNull();
    expect(status.lastFetched).toBeNull();
    expect(status.lastSynced).toBeNull();
  });

  test("status allows null conflict", () => {
    const status: SyncStatusEntry = {
      remoteName: "upstream",
      branch: "develop",
      localAhead: 2,
      localBehind: 1,
      hasUncommittedChanges: true,
      conflict: null,
      lastFetched: "2025-06-01T00:00:00.000Z",
      lastSynced: null,
    };
    expect(status.conflict).toBeNull();
    expect(status.hasUncommittedChanges).toBe(true);
  });
});

test.describe("aheadBehindText edge cases", () => {
  test("shows only ahead when only ahead", () => {
    const status: SyncStatusEntry = {
      remoteName: "r",
      branch: "b",
      localAhead: 10,
      localBehind: 0,
      hasUncommittedChanges: false,
      conflict: null,
      lastFetched: null,
      lastSynced: null,
    };
    expect(aheadBehindText(status)).toBe("10 ahead");
  });

  test("shows only behind when only behind", () => {
    const status: SyncStatusEntry = {
      remoteName: "r",
      branch: "b",
      localAhead: 0,
      localBehind: 7,
      hasUncommittedChanges: false,
      conflict: null,
      lastFetched: null,
      lastSynced: null,
    };
    expect(aheadBehindText(status)).toBe("7 behind");
  });

  test("shows both when diverged", () => {
    const status: SyncStatusEntry = {
      remoteName: "r",
      branch: "b",
      localAhead: 1,
      localBehind: 1,
      hasUncommittedChanges: false,
      conflict: null,
      lastFetched: null,
      lastSynced: null,
    };
    expect(aheadBehindText(status)).toBe("1 ahead, 1 behind");
  });
});
