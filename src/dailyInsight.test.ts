import { describe, it, expect } from "vitest";
import {
  computeDailyInsight,
  countUsageDays,
  normalizeUsageDays,
  type UsageTotals,
} from "./dailyInsight";

const MON_TO_FRI = new Set([1, 2, 3, 4, 5]);

// June 2026 starts on a Monday; the period is [Jun 1, Jul 1) in UTC.
const JUNE_START = new Date("2026-06-01T00:00:00.000Z");
const JULY_START = new Date("2026-07-01T00:00:00.000Z");

describe("countUsageDays", () => {
  it("counts weekdays across June 2026", () => {
    expect(countUsageDays(JUNE_START, JULY_START, MON_TO_FRI)).toBe(22);
  });

  it("counts every day when all weekdays are usage days", () => {
    const allDays = new Set([0, 1, 2, 3, 4, 5, 6]);
    expect(countUsageDays(JUNE_START, JULY_START, allDays)).toBe(30);
  });

  it("counts a single weekday across the month", () => {
    expect(countUsageDays(JUNE_START, JULY_START, new Set([6]))).toBe(4); // Saturdays
    expect(countUsageDays(JUNE_START, JULY_START, new Set([0]))).toBe(4); // Sundays
  });

  it("returns 0 for an empty or inverted range", () => {
    expect(countUsageDays(JUNE_START, JUNE_START, MON_TO_FRI)).toBe(0);
    expect(countUsageDays(JULY_START, JUNE_START, MON_TO_FRI)).toBe(0);
  });

  it("uses UTC so the count is timezone-independent", () => {
    // A boundary expressed at UTC midnight must not leak into the prior day.
    const elapsedToJun18 = countUsageDays(
      JUNE_START,
      new Date("2026-06-19T00:00:00.000Z"),
      MON_TO_FRI,
    );
    expect(elapsedToJun18).toBe(14);
  });
});

describe("normalizeUsageDays", () => {
  it("maps weekday names to indices", () => {
    expect([...normalizeUsageDays(["monday", "friday"])].sort()).toEqual([
      1, 5,
    ]);
  });

  it("is case- and whitespace-insensitive", () => {
    expect([...normalizeUsageDays(["Monday", " TUESDAY "])].sort()).toEqual([
      1, 2,
    ]);
  });

  it("accepts numeric indices", () => {
    expect([...normalizeUsageDays([0, 6])].sort()).toEqual([0, 6]);
  });

  it("ignores invalid entries", () => {
    expect([...normalizeUsageDays(["monday", "bogus", 3, 9])].sort()).toEqual([
      1, 3,
    ]);
  });

  it("falls back to Monday–Friday for empty or non-array input", () => {
    expect([...normalizeUsageDays([])].sort()).toEqual([1, 2, 3, 4, 5]);
    expect([...normalizeUsageDays(["bogus"])].sort()).toEqual([1, 2, 3, 4, 5]);
    expect([...normalizeUsageDays("monday")].sort()).toEqual([1, 2, 3, 4, 5]);
    expect([...normalizeUsageDays(undefined)].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("computeDailyInsight", () => {
  // Canonical example: $150 limit, $73.07 used, June period, today Jun 18.
  const totals: UsageTotals = {
    used: 7307,
    limit: 15000,
    remaining: 7693,
    periodStart: "2026-06-01T00:00:00.000Z",
    periodEnd: "2026-07-01T00:00:00.000Z",
  };
  const now = new Date("2026-06-18T12:00:00.000Z"); // Thursday

  it("computes dynamic pacing for the canonical example", () => {
    const insight = computeDailyInsight(totals, {
      usageDays: MON_TO_FRI,
      strategy: "dynamic",
      now,
    });

    expect(insight.usageDaysTotal).toBe(22);
    expect(insight.usageDaysElapsed).toBe(14);
    expect(insight.usageDaysRemaining).toBe(9);
    expect(insight.consumptionPerDay).toBeCloseTo(521.93, 1); // 7307 / 14
    expect(insight.recommendedPerDay).toBeCloseTo(854.78, 1); // 7693 / 9
    expect(insight.headroomPerDay).toBeCloseTo(332.85, 1);
    expect(insight.percentRemainingOfBudget).toBeCloseTo(38.94, 1);
    expect(insight.strategy).toBe("dynamic");
    expect(insight.todayIsUsageDay).toBe(true);
    expect(insight.usedFallbackPeriod).toBe(false);
  });

  it("computes the static budget from the full period", () => {
    const insight = computeDailyInsight(totals, {
      usageDays: MON_TO_FRI,
      strategy: "static",
      now,
    });

    expect(insight.recommendedPerDay).toBeCloseTo(681.82, 1); // 15000 / 22
  });

  it("leaves the budget undefined when there is no limit/remaining", () => {
    const insight = computeDailyInsight(
      {
        used: 7307,
        periodStart: totals.periodStart,
        periodEnd: totals.periodEnd,
      },
      { usageDays: MON_TO_FRI, strategy: "dynamic", now },
    );

    expect(insight.recommendedPerDay).toBeUndefined();
    expect(insight.headroomPerDay).toBeUndefined();
    expect(insight.percentRemainingOfBudget).toBeUndefined();
    expect(insight.consumptionPerDay).toBeCloseTo(521.93, 1);
  });

  it("falls back to the current calendar month when the period is missing", () => {
    const insight = computeDailyInsight(
      { used: 7307, limit: 15000, remaining: 7693 },
      { usageDays: MON_TO_FRI, strategy: "dynamic", now },
    );

    expect(insight.usedFallbackPeriod).toBe(true);
    expect(insight.usageDaysTotal).toBe(22); // June 2026 again
  });

  it("treats used as the average before the first usage day elapses", () => {
    const insight = computeDailyInsight(
      {
        used: 7307,
        limit: 15000,
        remaining: 7693,
        periodStart: "2026-07-01T00:00:00.000Z",
        periodEnd: "2026-08-01T00:00:00.000Z",
      },
      { usageDays: MON_TO_FRI, strategy: "dynamic", now }, // now is in June
    );

    expect(insight.usageDaysElapsed).toBe(0);
    expect(insight.consumptionPerDay).toBe(7307);
  });
});
