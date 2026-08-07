import { describe, expect, it } from "vitest";

import { classifyAccounts } from "./accounts";
import { normalizeLedger } from "./classify";
import { transactionsInRange } from "./aggregate";
import {
  addMonths,
  buildPeriod,
  comparisonRange,
  monthKeysInRange,
  rangeForPreset,
  rangeLengthInDays,
} from "./date-range";
import { makeBankAccount, makeExpense } from "./test-fixtures";

const TODAY = "2025-06-15";

describe("presets", () => {
  it("builds this month from the first to the last day", () => {
    expect(rangeForPreset("this_month", { today: TODAY })).toEqual({
      start: "2025-06-01",
      end: "2025-06-30",
    });
  });

  it("builds the calendar quarter containing today", () => {
    expect(rangeForPreset("this_quarter", { today: TODAY })).toEqual({
      start: "2025-04-01",
      end: "2025-06-30",
    });
    expect(rangeForPreset("this_quarter", { today: "2025-01-05" })).toEqual({
      start: "2025-01-01",
      end: "2025-03-31",
    });
  });

  it("ends year to date on today, not on 31 December", () => {
    expect(rangeForPreset("year_to_date", { today: TODAY })).toEqual({
      start: "2025-01-01",
      end: "2025-06-15",
    });
  });

  it("builds twelve whole months for last 12 months", () => {
    const range = rangeForPreset("last_12_months", { today: TODAY });
    expect(range).toEqual({ start: "2024-06-16", end: "2025-06-15" });
    expect(rangeLengthInDays(range)).toBe(365);
  });

  it("builds the prior calendar year across the year boundary", () => {
    expect(rangeForPreset("prior_calendar_year", { today: "2025-01-01" })).toEqual({
      start: "2024-01-01",
      end: "2024-12-31",
    });
  });

  it("falls back to year to date when a custom range is invalid", () => {
    const range = rangeForPreset("custom", {
      today: TODAY,
      custom: { start: "2025-06-30", end: "2025-06-01" },
    });
    expect(range).toEqual({ start: "2025-01-01", end: "2025-06-15" });
  });
});

describe("comparison periods", () => {
  it("uses the immediately preceding window of the same length", () => {
    const range = { start: "2025-06-01", end: "2025-06-30" };
    expect(comparisonRange(range, "previous_period")).toEqual({
      start: "2025-05-02",
      end: "2025-05-31",
    });
  });

  it("shifts by a calendar year for same period last year", () => {
    const range = { start: "2025-01-01", end: "2025-06-15" };
    expect(comparisonRange(range, "same_period_last_year")).toEqual({
      start: "2024-01-01",
      end: "2024-06-15",
    });
  });

  it("handles a leap day without producing an invalid date", () => {
    expect(comparisonRange({ start: "2024-02-29", end: "2024-02-29" }, "same_period_last_year")).toEqual({
      start: "2023-02-28",
      end: "2023-02-28",
    });
  });

  it("returns nothing when comparison is switched off", () => {
    expect(comparisonRange({ start: "2025-01-01", end: "2025-06-15" }, "none")).toBeNull();
  });

  it("compares a year-to-date range against the same months last year", () => {
    const period = buildPeriod({
      preset: "year_to_date",
      comparisonMode: "same_period_last_year",
      today: "2025-03-10",
    });
    expect(period.comparison).toEqual({ start: "2024-01-01", end: "2024-03-10" });
  });
});

describe("range filtering", () => {
  const accounts = classifyAccounts({ bankAccounts: [makeBankAccount()] });

  function within(range: { start: string; end: string }, dates: string[]) {
    const { transactions } = normalizeLedger({
      expenses: dates.map((date) => makeExpense({ transaction_date: date })),
      accounts,
    });
    return transactionsInRange(transactions, range).length;
  }

  it("includes both boundary dates", () => {
    expect(within({ start: "2025-06-01", end: "2025-06-30" }, ["2025-06-01", "2025-06-30"])).toBe(2);
  });

  it("excludes the days either side of the boundary", () => {
    expect(within({ start: "2025-06-01", end: "2025-06-30" }, ["2025-05-31", "2025-07-01"])).toBe(0);
  });

  it("does not leak December into the following January", () => {
    expect(within({ start: "2025-01-01", end: "2025-01-31" }, ["2024-12-31"])).toBe(0);
    expect(within({ start: "2024-12-01", end: "2024-12-31" }, ["2025-01-01"])).toBe(0);
  });
});

describe("month helpers", () => {
  it("clamps a month shift to the shorter month", () => {
    expect(addMonths("2025-03-31", -1)).toBe("2025-02-28");
    expect(addMonths("2024-03-31", -1)).toBe("2024-02-29");
  });

  it("crosses the year boundary correctly", () => {
    expect(addMonths("2025-01-15", -1)).toBe("2024-12-15");
    expect(addMonths("2024-12-15", 1)).toBe("2025-01-15");
  });

  it("lists every month a range touches, including empty ones", () => {
    expect(monthKeysInRange({ start: "2024-11-15", end: "2025-02-03" })).toEqual([
      "2024-11",
      "2024-12",
      "2025-01",
      "2025-02",
    ]);
  });
});
