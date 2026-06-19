// Pure, vscode-free pacing math for the daily usage view. Keeping it isolated
// from the extension host makes it unit-testable and easy to reason about.

export type DailyBudgetStrategy = "dynamic" | "static";

// The subset of usage totals the daily math needs (a UsageSnapshot is a
// structural superset, so it can be passed directly).
export type UsageTotals = {
  used: number;
  limit?: number;
  remaining?: number;
  periodStart?: string;
  periodEnd?: string;
};

export type DailyInsight = {
  recommendedPerDay?: number; // cents — undefined when limit/period unknown
  consumptionPerDay: number; // cents — average = used / usageDaysElapsed
  headroomPerDay?: number; // recommendedPerDay - consumptionPerDay (may be < 0)
  percentRemainingOfBudget?: number; // headroom / recommendedPerDay * 100
  usageDaysTotal: number;
  usageDaysElapsed: number;
  usageDaysRemaining: number; // includes today when today is a usage day
  strategy: DailyBudgetStrategy;
  todayIsUsageDay: boolean;
  usedFallbackPeriod: boolean;
};

export type DailyInsightOptions = {
  usageDays: Set<number>;
  strategy: DailyBudgetStrategy;
  now: Date;
};

export const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};
export const DEFAULT_USAGE_DAYS = [1, 2, 3, 4, 5];

// Accepts weekday names ("monday") or indices (0–6, Sunday=0); invalid entries
// are ignored and an empty result falls back to Monday–Friday.
export function normalizeUsageDays(value: unknown): Set<number> {
  const days = new Set<number>();

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string") {
        const index = WEEKDAY_INDEX[entry.trim().toLowerCase()];
        if (index !== undefined) {
          days.add(index);
        }
      } else if (
        typeof entry === "number" &&
        Number.isInteger(entry) &&
        entry >= 0 &&
        entry <= 6
      ) {
        days.add(entry);
      }
    }
  }

  if (days.size === 0) {
    for (const day of DEFAULT_USAGE_DAYS) {
      days.add(day);
    }
  }

  return days;
}

// Counts calendar days in [from, to) whose weekday is a usage day. Dates are
// handled in UTC so counts align with the (UTC) billing period boundaries and
// stay independent of the machine timezone.
export function countUsageDays(
  from: Date,
  to: Date,
  days: Set<number>,
): number {
  if (!(from.getTime() < to.getTime())) {
    return 0;
  }

  let count = 0;
  const cursor = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
  );
  const end = to.getTime();
  while (cursor.getTime() < end) {
    if (days.has(cursor.getUTCDay())) {
      count += 1;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return count;
}

function computeRecommendedPerDay(
  totals: UsageTotals,
  strategy: DailyBudgetStrategy,
  counts: { usageDaysTotal: number; usageDaysRemaining: number },
): number | undefined {
  if (strategy === "static") {
    if (totals.limit === undefined || counts.usageDaysTotal <= 0) {
      return undefined;
    }
    return totals.limit / counts.usageDaysTotal;
  }

  // dynamic: pace the remaining balance across the usage days still ahead.
  if (totals.remaining === undefined) {
    return undefined;
  }
  if (counts.usageDaysRemaining <= 0) {
    return totals.remaining;
  }
  return totals.remaining / counts.usageDaysRemaining;
}

export function computeDailyInsight(
  totals: UsageTotals,
  options: DailyInsightOptions,
): DailyInsight {
  const { usageDays, strategy, now } = options;

  let usedFallbackPeriod = false;
  let start = totals.periodStart ? new Date(totals.periodStart) : undefined;
  let end = totals.periodEnd ? new Date(totals.periodEnd) : undefined;
  if (
    !start ||
    Number.isNaN(start.getTime()) ||
    !end ||
    Number.isNaN(end.getTime()) ||
    !(start.getTime() < end.getTime())
  ) {
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    usedFallbackPeriod = true;
  }

  const startOfToday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const startOfTomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );

  const usageDaysTotal = countUsageDays(start, end, usageDays);
  // Elapsed counts usage days from the period start up to and including today.
  const elapsedEnd =
    startOfTomorrow.getTime() < end.getTime() ? startOfTomorrow : end;
  const usageDaysElapsed = countUsageDays(start, elapsedEnd, usageDays);
  // Remaining counts usage days from today onward (today is still spendable).
  const remainingStart =
    startOfToday.getTime() > start.getTime() ? startOfToday : start;
  const usageDaysRemaining = countUsageDays(remainingStart, end, usageDays);

  const todayIsUsageDay =
    usageDays.has(now.getUTCDay()) &&
    startOfToday.getTime() >= start.getTime() &&
    startOfToday.getTime() < end.getTime();

  const consumptionPerDay =
    usageDaysElapsed > 0 ? totals.used / usageDaysElapsed : totals.used;

  const recommendedPerDay = computeRecommendedPerDay(totals, strategy, {
    usageDaysTotal,
    usageDaysRemaining,
  });

  let headroomPerDay: number | undefined;
  let percentRemainingOfBudget: number | undefined;
  if (recommendedPerDay !== undefined) {
    headroomPerDay = recommendedPerDay - consumptionPerDay;
    percentRemainingOfBudget =
      recommendedPerDay > 0
        ? (headroomPerDay / recommendedPerDay) * 100
        : undefined;
  }

  return {
    recommendedPerDay,
    consumptionPerDay,
    headroomPerDay,
    percentRemainingOfBudget,
    usageDaysTotal,
    usageDaysElapsed,
    usageDaysRemaining,
    strategy,
    todayIsUsageDay,
    usedFallbackPeriod,
  };
}
