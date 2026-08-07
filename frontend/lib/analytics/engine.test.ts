import { describe, expect, it } from "vitest";

import { buildPeriod } from "./date-range";
import { EMPTY_SOURCE_DATA, runAnalytics, type AnalyticsSourceData } from "./engine";
import { MIN_TRANSACTIONS_FOR_SCORE } from "./health";
import { summarizeBudgets } from "./budgets";
import { summarizeCashFlow, MIN_MONTHS_FOR_FORECAST } from "./cash-flow";
import { classifyAccounts } from "./accounts";
import { normalizeLedger } from "./classify";
import {
  makeBankAccount,
  makeBudget,
  makeExpense,
  makeOpeningBalance,
  makeSettings,
} from "./test-fixtures";
import type { AnalyticsExpenseRow } from "./types";

const TODAY = "2025-06-30";

const checking = makeBankAccount({ id: "acct-checking", name: "Operating Checking" });

function period(preset: "year_to_date" | "this_month" = "year_to_date") {
  return buildPeriod({ preset, comparisonMode: "same_period_last_year", today: TODAY });
}

function sourceData(overrides: Partial<AnalyticsSourceData> = {}): AnalyticsSourceData {
  return {
    ...EMPTY_SOURCE_DATA,
    bankAccounts: [checking],
    openingBalances: [makeOpeningBalance({ account_id: "acct-checking" })],
    ...overrides,
  };
}

function manyExpenses(count: number): AnalyticsExpenseRow[] {
  return Array.from({ length: count }, (_, index) =>
    makeExpense({
      transaction_date: `2025-0${(index % 6) + 1}-10`,
      category: index % 2 === 0 ? "Fuel" : "Equipment",
      payee: index % 2 === 0 ? "Fuel Depot" : "Firehouse Supply Co",
      total_amount: "100.00",
    }),
  );
}

describe("empty and sparse states", () => {
  it("reports an empty department instead of zeroed charts", () => {
    const result = runAnalytics({
      data: EMPTY_SOURCE_DATA,
      period: period(),
      settings: makeSettings(),
      today: TODAY,
    });

    expect(result.isEmpty).toBe(true);
    expect(result.hasAccounts).toBe(false);
    expect(result.categories).toEqual([]);
    expect(result.vendors).toEqual([]);
    expect(result.totals.expenseCents).toBe(0);
  });

  it("produces no invalid percentages from empty data", () => {
    const result = runAnalytics({
      data: EMPTY_SOURCE_DATA,
      period: period(),
      settings: makeSettings(),
      today: TODAY,
    });

    expect(result.documentation.receiptCompletionPercent).toBeNull();
    expect(result.expenseChange.percent).toBeNull();
    expect(result.health.score).toBeNull();
  });

  it("distinguishes no accounts connected from no spending in the period", () => {
    const noAccounts = runAnalytics({
      data: EMPTY_SOURCE_DATA,
      period: period(),
      settings: makeSettings(),
      today: TODAY,
    });
    expect(noAccounts.hasAccounts).toBe(false);

    const noSpending = runAnalytics({
      data: sourceData(),
      period: period(),
      settings: makeSettings(),
      today: TODAY,
    });
    expect(noSpending.hasAccounts).toBe(true);
    expect(noSpending.currentTransactions).toHaveLength(0);
  });
});

describe("health scoring", () => {
  it("says insufficient data rather than inventing a score for a new department", () => {
    const result = runAnalytics({
      data: sourceData({ expenses: manyExpenses(MIN_TRANSACTIONS_FOR_SCORE - 1) }),
      period: period(),
      settings: makeSettings(),
      today: TODAY,
    });

    expect(result.health.hasSufficientData).toBe(false);
    expect(result.health.score).toBeNull();
    expect(result.health.status).toBeNull();
    expect(result.health.level).toBe("unknown");
    expect(result.health.insufficientDataReason).toContain("at least");
  });

  it("scores a department once there is enough activity", () => {
    const result = runAnalytics({
      data: sourceData({ expenses: manyExpenses(20) }),
      period: period(),
      settings: makeSettings(),
      today: TODAY,
    });

    expect(result.health.hasSufficientData).toBe(true);
    expect(result.health.score).toBeGreaterThan(0);
    expect(result.health.status).toBeTruthy();
  });

  it("does not mark a department down purely for having a short history", () => {
    // Both departments keep clean books and stay solidly in the black; the only
    // difference is how many months of records they have.
    const wellFunded = [
      makeOpeningBalance({ account_id: "acct-checking", beginning_balance: "500000.00" }),
    ];

    const shortHistory = runAnalytics({
      data: sourceData({ expenses: manyExpenses(12), openingBalances: wellFunded }),
      period: period(),
      settings: makeSettings(),
      today: TODAY,
    });
    const longHistory = runAnalytics({
      data: sourceData({ expenses: manyExpenses(120), openingBalances: wellFunded }),
      period: period(),
      settings: makeSettings(),
      today: TODAY,
    });

    expect(shortHistory.health.score).toBe(longHistory.health.score);
  });

  it("never claims certainty in its wording", () => {
    const result = runAnalytics({
      data: sourceData({ expenses: manyExpenses(20) }),
      period: period(),
      settings: makeSettings(),
      today: TODAY,
    });

    expect(result.health.methodology).toMatch(/not an audit/i);
    expect(result.health.methodology).not.toMatch(/certif/i);
  });

  it("explains every component it scored", () => {
    const result = runAnalytics({
      data: sourceData({ expenses: manyExpenses(20) }),
      period: period(),
      settings: makeSettings(),
      today: TODAY,
    });

    for (const component of result.health.components) {
      expect(component.method.length).toBeGreaterThan(0);
      expect(component.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("insights", () => {
  it("cites the exact metrics behind every insight", () => {
    const expenses = [
      ...manyExpenses(20),
      ...Array.from({ length: 6 }, () =>
        makeExpense({
          transaction_date: "2025-05-05",
          receipt_path: "dept/no-receipt",
          original_filename: "manual-entry",
          total_amount: "80.00",
        }),
      ),
    ];

    const result = runAnalytics({
      data: sourceData({ expenses }),
      period: period(),
      settings: makeSettings(),
      today: TODAY,
    });

    expect(result.insights.length).toBeGreaterThan(0);
    for (const insight of result.insights) {
      expect(insight.citations.length).toBeGreaterThan(0);
      expect(insight.method.length).toBeGreaterThan(0);
      expect(insight.recommendedAction.length).toBeGreaterThan(0);
      for (const citation of insight.citations) {
        expect(citation.value).not.toBe("");
        expect(citation.value).not.toMatch(/NaN|Infinity/);
      }
    }
  });

  it("raises a missing-receipt insight whose figures match the metrics", () => {
    const expenses = [
      ...manyExpenses(10),
      ...Array.from({ length: 5 }, () =>
        makeExpense({
          transaction_date: "2025-05-05",
          receipt_path: "dept/no-receipt",
          original_filename: "manual-entry",
        }),
      ),
    ];

    const result = runAnalytics({
      data: sourceData({ expenses }),
      period: period(),
      settings: makeSettings(),
      today: TODAY,
    });

    const insight = result.insights.find((entry) => entry.id === "missing_receipts");
    expect(insight).toBeDefined();

    const cited = insight?.citations.find((citation) => citation.label === "Missing receipts");
    expect(cited?.rawValue).toBe(result.documentation.missingReceiptCount);
  });

  it("produces no insights at all from an empty department", () => {
    const result = runAnalytics({
      data: EMPTY_SOURCE_DATA,
      period: period(),
      settings: makeSettings(),
      today: TODAY,
    });

    expect(result.insights).toEqual([]);
  });
});

describe("budgets", () => {
  const accounts = classifyAccounts({ bankAccounts: [checking] });

  function transactionsFor(expenses: AnalyticsExpenseRow[]) {
    return normalizeLedger({ expenses, accounts }).transactions;
  }

  it("reports no budgets rather than empty progress bars", () => {
    const summary = summarizeBudgets({
      budgets: [],
      transactions: transactionsFor([makeExpense()]),
      fiscalYear: 2025,
      today: TODAY,
    });

    expect(summary.hasBudgets).toBe(false);
    expect(summary.lines).toEqual([]);
  });

  it("compares actual spending against the budget for the year", () => {
    const summary = summarizeBudgets({
      budgets: [makeBudget({ category: "Equipment", amount: "5000.00" })],
      transactions: transactionsFor([
        makeExpense({ category: "Equipment", total_amount: "2000.00", transaction_date: "2025-02-01" }),
        makeExpense({ category: "Equipment", total_amount: "1000.00", transaction_date: "2025-03-01" }),
        // Different year, so it must not be counted.
        makeExpense({ category: "Equipment", total_amount: "9000.00", transaction_date: "2024-03-01" }),
      ]),
      fiscalYear: 2025,
      today: TODAY,
    });

    expect(summary.lines[0].actualCents).toBe(300_000);
    expect(summary.lines[0].remainingCents).toBe(200_000);
    expect(summary.lines[0].percentConsumed).toBeCloseTo(60);
  });

  it("does not call ordinary mid-year progress a problem", () => {
    const summary = summarizeBudgets({
      budgets: [makeBudget({ category: "Fuel", amount: "1200.00" })],
      transactions: transactionsFor([
        makeExpense({ category: "Fuel", total_amount: "500.00", transaction_date: "2025-03-01" }),
      ]),
      fiscalYear: 2025,
      today: TODAY,
    });

    expect(summary.lines[0].status).toBe("on_track");
    expect(summary.overBudgetCount).toBe(0);
  });

  it("flags a category that is genuinely over", () => {
    const summary = summarizeBudgets({
      budgets: [makeBudget({ category: "Fuel", amount: "100.00" })],
      transactions: transactionsFor([
        makeExpense({ category: "Fuel", total_amount: "500.00", transaction_date: "2025-03-01" }),
      ]),
      fiscalYear: 2025,
      today: TODAY,
    });

    expect(summary.lines[0].status).toBe("over_budget");
  });

  it("nets refunds off the actual spend", () => {
    const summary = summarizeBudgets({
      budgets: [makeBudget({ category: "Equipment", amount: "5000.00" })],
      transactions: transactionsFor([
        makeExpense({ category: "Equipment", total_amount: "1000.00", transaction_date: "2025-02-01" }),
        makeExpense({
          category: "Equipment",
          description: "Refund for returned item",
          total_amount: "-400.00",
          transaction_date: "2025-02-10",
        }),
      ]),
      fiscalYear: 2025,
      today: TODAY,
    });

    expect(summary.lines[0].actualCents).toBe(60_000);
  });
});

describe("cash-flow outlook", () => {
  const accounts = classifyAccounts({ bankAccounts: [checking] });

  it("withholds a forecast when there is too little history", () => {
    const summary = summarizeCashFlow({
      transactions: normalizeLedger({
        expenses: [makeExpense({ transaction_date: "2025-06-01" })],
        accounts,
      }).transactions,
      currentBalanceCents: 100_000,
      today: TODAY,
    });

    expect(summary.outlook.available).toBe(false);
    expect(summary.outlook.unavailableReason).toContain(String(MIN_MONTHS_FOR_FORECAST));
  });

  it("withholds a forecast when no balance is established", () => {
    const summary = summarizeCashFlow({
      transactions: normalizeLedger({
        expenses: [
          makeExpense({ transaction_date: "2025-04-01" }),
          makeExpense({ transaction_date: "2025-05-01" }),
          makeExpense({ transaction_date: "2025-06-01" }),
        ],
        accounts,
      }).transactions,
      currentBalanceCents: null,
      today: TODAY,
    });

    expect(summary.outlook.available).toBe(false);
    expect(summary.outlook.unavailableReason).toContain("balance");
  });

  it("labels the forecast as an estimate and states its basis", () => {
    const summary = summarizeCashFlow({
      transactions: normalizeLedger({
        expenses: [
          makeExpense({ transaction_date: "2025-04-01", total_amount: "100.00" }),
          makeExpense({ transaction_date: "2025-05-01", total_amount: "100.00" }),
          makeExpense({ transaction_date: "2025-06-01", total_amount: "100.00" }),
        ],
        accounts,
      }).transactions,
      currentBalanceCents: 1_000_000,
      today: TODAY,
    });

    expect(summary.outlook.available).toBe(true);
    expect(summary.outlook.basis).toMatch(/estimated/i);
    expect(summary.outlook.projections.map((entry) => entry.horizonDays)).toEqual([30, 60, 90]);
  });
});

describe("vendors on record", () => {
  it("keeps listing a saved vendor that had no spending in the period", () => {
    const result = runAnalytics({
      data: sourceData({
        expenses: [makeExpense({ payee: "Fuel Depot", total_amount: "100.00" })],
        knownVendors: [
          { id: "v-1", name: "Fuel Depot", normalized_name: "fuel depot", default_category: "Fuel" },
          {
            id: "v-2",
            name: "Ladder Service Co",
            normalized_name: "ladder service co",
            default_category: "Apparatus",
          },
        ],
      }),
      period: period(),
      settings: makeSettings(),
      today: TODAY,
    });

    expect(result.vendors.map((vendor) => vendor.name)).toEqual(["Fuel Depot"]);
    expect(result.vendorsWithoutActivity).toEqual([
      { name: "Ladder Service Co", defaultCategory: "Apparatus" },
    ]);
  });
});

describe("filters", () => {
  it("restricts every figure to the selected account", () => {
    const other = makeBankAccount({ id: "acct-other", name: "Fundraiser Checking", is_default: false });

    const result = runAnalytics({
      data: sourceData({
        bankAccounts: [checking, other],
        expenses: [
          makeExpense({ bank_account_name: "Operating Checking", total_amount: "100.00" }),
          makeExpense({ bank_account_name: "Fundraiser Checking", total_amount: "900.00" }),
        ],
      }),
      period: period(),
      settings: makeSettings(),
      filters: { accountIds: ["acct-checking"], categories: [] },
      today: TODAY,
    });

    expect(result.totals.expenseCents).toBe(10_000);
  });

  it("restricts every figure to the selected categories", () => {
    const result = runAnalytics({
      data: sourceData({
        expenses: [
          makeExpense({ category: "Fuel", total_amount: "100.00" }),
          makeExpense({ category: "Equipment", total_amount: "900.00" }),
        ],
      }),
      period: period(),
      settings: makeSettings(),
      filters: { accountIds: [], categories: ["Fuel"] },
      today: TODAY,
    });

    expect(result.totals.expenseCents).toBe(10_000);
    expect(result.categories).toHaveLength(1);
  });
});
