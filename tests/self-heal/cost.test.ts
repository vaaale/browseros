import "../services/_stub-server-only";
import { test, expect } from "@playwright/test";
import * as cost from "../../src/lib/self-heal/cost";
import { appendCostLedger } from "../../src/lib/self-heal/store";
import { useSelfHealTestRoot } from "./_test-env";

// 031-self-healing FR-020 / design ADR-5. The cap is grounded in REAL
// provider-reported usage; the estimate is a marked fallback for providers that
// report nothing. Two properties matter most here: the reset is at UTC midnight
// (not local, so it doesn't move with the timezone), and "no usage reported" is
// never silently recorded as a free run.

const DAY = 86_400_000;

test.describe("getDayKey", () => {
  test("is the UTC calendar day", () => {
    expect(cost.getDayKey(Date.UTC(2026, 8, 7, 23, 59, 59))).toBe("2026-09-07");
    expect(cost.getDayKey(Date.UTC(2026, 8, 8, 0, 0, 1))).toBe("2026-09-08");
  });

  test("rolls exactly at UTC midnight, not at local midnight", () => {
    // 2026-09-07T23:30Z is still the 7th in UTC even where it is already the 8th
    // locally — the cap must not reset early for a user east of UTC.
    expect(cost.getDayKey(Date.UTC(2026, 8, 7, 23, 30))).toBe("2026-09-07");
    expect(cost.getDayKey(Date.UTC(2026, 8, 8, 0, 0))).toBe("2026-09-08");
  });
});

test.describe("estimateTokens / tokensForRun", () => {
  test("real provider usage is used verbatim and marked not-estimated", () => {
    const out = cost.tokensForRun({ inputTokens: 900, outputTokens: 100, totalTokens: 1_000 }, ["ignored"]);
    expect(out).toEqual({ tokens: 1_000, estimated: false });
  });

  test("missing usage falls back to a MARKED estimate rather than reporting zero cost", () => {
    const out = cost.tokensForRun(undefined, ["x".repeat(400), "y".repeat(400)]);
    expect(out.estimated).toBe(true);
    expect(out.tokens).toBe(200); // 800 chars / 4
  });

  test("a zero-total usage report is treated as no report (a run is never free)", () => {
    const out = cost.tokensForRun({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }, ["abcd"]);
    expect(out.estimated).toBe(true);
    expect(out.tokens).toBeGreaterThan(0);
  });

  test("the estimate never returns zero, even for empty text", () => {
    expect(cost.estimateTokens()).toBe(1);
    expect(cost.estimateTokens("", undefined)).toBe(1);
  });
});

test.describe("the ledger + the cap", () => {
  test("recordCaseCost appends a real-usage entry", async () => {
    const root = useSelfHealTestRoot("cost-record");
    try {
      const entry = await cost.recordCaseCost("0001", "diagnostician", {
        inputTokens: 4_000,
        outputTokens: 1_000,
        totalTokens: 5_000,
      });
      expect(entry.tokens).toBe(5_000);
      expect(entry.estimated).toBeUndefined();
      expect(await cost.tokensSpentToday()).toBe(5_000);
    } finally {
      await root.cleanup();
    }
  });

  test("recordCaseCost marks an estimated entry when the provider reported nothing", async () => {
    const root = useSelfHealTestRoot("cost-estimate");
    try {
      const entry = await cost.recordCaseCost("0001", "pipeline", undefined, ["x".repeat(40)]);
      expect(entry.estimated).toBe(true);
      expect(entry.tokens).toBe(10);
    } finally {
      await root.cleanup();
    }
  });

  test("only TODAY's entries count toward the cap", async () => {
    const root = useSelfHealTestRoot("cost-today");
    try {
      const now = Date.now();
      await appendCostLedger({ caseId: "0001", role: "pipeline", tokens: 999_999, at: now - 2 * DAY });
      await appendCostLedger({ caseId: "0002", role: "pipeline", tokens: 25, at: now });
      expect(await cost.tokensSpentToday(now)).toBe(25);
    } finally {
      await root.cleanup();
    }
  });

  test("capExhaustedForToday flips once the configured cap is reached", async () => {
    const root = useSelfHealTestRoot("cost-cap");
    try {
      root.writeConfig({ enabled: true, costCapPerDay: 100 });
      expect(await cost.capExhaustedForToday()).toBe(false);
      await cost.recordCaseCost("0001", "diagnostician", { inputTokens: 60, outputTokens: 40, totalTokens: 100 });
      expect(await cost.capExhaustedForToday()).toBe(true);
    } finally {
      await root.cleanup();
    }
  });

  test("yesterday's spend does NOT keep the cap exhausted (the UTC-midnight reset)", async () => {
    const root = useSelfHealTestRoot("cost-reset");
    try {
      root.writeConfig({ enabled: true, costCapPerDay: 100 });
      await appendCostLedger({ caseId: "0001", role: "pipeline", tokens: 5_000, at: Date.now() - DAY });
      expect(await cost.capExhaustedForToday()).toBe(false);
    } finally {
      await root.cleanup();
    }
  });

  test("a cap of 0 means NO cap, not 'block everything'", async () => {
    const root = useSelfHealTestRoot("cost-nocap");
    try {
      root.writeConfig({ enabled: true, costCapPerDay: 0 });
      await cost.recordCaseCost("0001", "pipeline", { inputTokens: 1, outputTokens: 1, totalTokens: 999_999 });
      expect(await cost.capExhaustedForToday()).toBe(false);
    } finally {
      await root.cleanup();
    }
  });

  test("costStatus reports what the UI shows", async () => {
    const root = useSelfHealTestRoot("cost-status");
    try {
      root.writeConfig({ enabled: true, costCapPerDay: 500 });
      await cost.recordCaseCost("0001", "diagnostician", { inputTokens: 100, outputTokens: 400, totalTokens: 500 });
      const status = await cost.costStatus();
      expect(status.spentToday).toBe(500);
      expect(status.capPerDay).toBe(500);
      expect(status.exhausted).toBe(true);
      expect(status.day).toBe(cost.getDayKey());
    } finally {
      await root.cleanup();
    }
  });

  test("the default cap is 1,000,000 tokens/day (design R5, user-confirmed)", async () => {
    const root = useSelfHealTestRoot("cost-default");
    try {
      const status = await cost.costStatus();
      expect(status.capPerDay).toBe(1_000_000);
      expect(status.exhausted).toBe(false);
    } finally {
      await root.cleanup();
    }
  });
});
