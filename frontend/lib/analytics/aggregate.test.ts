import { describe, expect, it } from "vitest";

import { classifyAccounts } from "./accounts";
import { normalizeLedger } from "./classify";
import {
  accountActivity,
  cashPosition,
  categoryTotals,
  changeBetween,
  collapseSmallCategories,
  monthlyTrend,
  transactionsInRange,
  vendorTotals,
} from "./aggregate";
import { documentationMetrics } from "./documentation";
import { makeBankAccount, makeExpense } from "./test-fixtures";
import type { AnalyticsExpenseRow, ClassifiedAccount } from "./types";

const checking = makeBankAccount({ id: "acct-checking", name: "Operating Checking" });
const card = makeBankAccount({
  id: "acct-card",
  name: "Department Visa",
  account_type: "Credit Card",
  is_default: false,
  fund_type: null,
});

function accounts(): ClassifiedAccount[] {
  return classifyAccounts({ bankAccounts: [checking, card] });
}

function normalize(expenses: AnalyticsExpenseRow[]) {
  return normalizeLedger({ expenses, accounts: accounts() }).transactions;
}

describe("period comparisons", () => {
  it("reports the dollar and percentage change", () => {
    const change = changeBetween(15_000, 10_000);
    expect(change.deltaCents).toBe(5_000);
    expect(change.percent).toBeCloseTo(50);
    expect(change.hasComparison).toBe(true);
  });

  it("gives no percentage when the baseline was zero", () => {
    const change = changeBetween(15_000, 0);
    expect(change.deltaCents).toBe(15_000);
    expect(change.percent).toBeNull();
    expect(change.hasComparison).toBe(true);
  });

  it("distinguishes no comparison history from a zero-percent change", () => {
    const noHistory = changeBetween(15_000, null);
    expect(noHistory.hasComparison).toBe(false);
    expect(noHistory.percent).toBeNull();

    const unchanged = changeBetween(15_000, 15_000);
    expect(unchanged.hasComparison).toBe(true);
    expect(unchanged.percent).toBe(0);
  });
});

describe("category totals", () => {
  const expenses = [
    makeExpense({ category: "Fuel", total_amount: "600.00" }),
    makeExpense({ category: "Fuel", total_amount: "400.00" }),
    makeExpense({ category: "Equipment", total_amount: "1000.00" }),
    makeExpense({ category: null, total_amount: "200.00" }),
  ];

  it("sums and ranks categories with shares that add up", () => {
    const rows = categoryTotals({ current: normalize(expenses) });
    const total = rows.reduce((sum, row) => sum + row.percentOfTotal, 0);

    expect(rows[0].category).toBe("Equipment");
    expect(rows[0].amountCents).toBe(100_000);
    expect(rows.find((row) => row.category === "Fuel")?.amountCents).toBe(100_000);
    expect(rows.find((row) => row.category === "Uncategorized")?.amountCents).toBe(20_000);
    expect(total).toBeCloseTo(100);
  });

  it("excludes transfers and card payments from the category breakdown", () => {
    const rows = categoryTotals({
      current: normalize([
        makeExpense({ category: "Fuel", total_amount: "100.00" }),
        makeExpense({ category: "Transfer", payee: "Department Visa", total_amount: "900.00" }),
      ]),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe("Fuel");
  });

  it("merges the long tail into Other only when more than one slice is small", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      makeExpense({ category: `Category ${index}`, total_amount: index === 0 ? "10000.00" : "10.00" }),
    );
    const collapsed = collapseSmallCategories(categoryTotals({ current: normalize(many) }));

    expect(collapsed.at(-1)?.category).toBe("Other");
    expect(collapsed.length).toBeLessThan(12);
  });

  it("leaves a single small category under its own name", () => {
    const rows = categoryTotals({
      current: normalize([
        makeExpense({ category: "Fuel", total_amount: "10000.00" }),
        makeExpense({ category: "Stamps", total_amount: "5.00" }),
      ]),
    });

    expect(collapseSmallCategories(rows).map((row) => row.category)).toEqual(["Fuel", "Stamps"]);
  });
});

describe("vendor totals", () => {
  const expenses = [
    makeExpense({
      payee: "Fuel Depot",
      category: "Fuel",
      transaction_date: "2025-01-10",
      total_amount: "300.00",
    }),
    makeExpense({
      payee: "Fuel Depot",
      category: "Fuel",
      transaction_date: "2025-03-20",
      total_amount: "500.00",
    }),
    makeExpense({
      payee: "Fuel Depot",
      category: "Equipment",
      transaction_date: "2025-02-05",
      total_amount: "100.00",
      receipt_path: "dept/no-receipt",
      original_filename: "manual-entry",
    }),
    makeExpense({ payee: "Uniform Depot", category: "Uniforms", total_amount: "200.00" }),
  ];

  it("totals spend, count, average and largest purchase per vendor", () => {
    const [top] = vendorTotals({ current: normalize(expenses) });

    expect(top.name).toBe("Fuel Depot");
    expect(top.totalSpendCents).toBe(90_000);
    expect(top.transactionCount).toBe(3);
    expect(top.averageCents).toBe(30_000);
    expect(top.largestCents).toBe(50_000);
  });

  it("ranks the vendor's top categories by spend", () => {
    const [top] = vendorTotals({ current: normalize(expenses) });
    expect(top.topCategories[0]).toEqual({ category: "Fuel", amountCents: 80_000 });
    expect(top.topCategories[1]).toEqual({ category: "Equipment", amountCents: 10_000 });
  });

  it("reports first and most recent activity and missing receipts", () => {
    const [top] = vendorTotals({ current: normalize(expenses) });
    expect(top.firstActivity).toBe("2025-01-10");
    expect(top.lastActivity).toBe("2025-03-20");
    expect(top.missingReceiptCount).toBe(1);
  });

  it("computes each vendor's share of total spending", () => {
    const rows = vendorTotals({ current: normalize(expenses) });
    expect(rows[0].percentOfSpend).toBeCloseTo(81.82, 1);
    expect(rows[1].percentOfSpend).toBeCloseTo(18.18, 1);
  });

  it("compares a vendor against the prior period", () => {
    const rows = vendorTotals({
      current: normalize([makeExpense({ payee: "Fuel Depot", total_amount: "500.00" })]),
      prior: normalize([makeExpense({ payee: "Fuel Depot", total_amount: "250.00" })]),
    });

    expect(rows[0].change.priorCents).toBe(25_000);
    expect(rows[0].change.percent).toBeCloseTo(100);
  });

  it("does not count transfers or card payments as vendor spending", () => {
    const rows = vendorTotals({
      current: normalize([
        makeExpense({ payee: "Department Visa", description: "Credit card payment", total_amount: "900.00" }),
      ]),
    });

    expect(rows).toHaveLength(0);
  });

  it("returns an empty list rather than invalid percentages with no data", () => {
    const rows = vendorTotals({ current: [] });
    expect(rows).toEqual([]);
  });
});

describe("monthly trend", () => {
  it("buckets by month and keeps empty months in the series", () => {
    const points = monthlyTrend(
      normalize([
        makeExpense({ transaction_date: "2025-01-15", total_amount: "100.00" }),
        makeExpense({ transaction_date: "2025-03-15", total_amount: "300.00" }),
        makeExpense({ transaction_date: "2025-03-20", category: "Income", total_amount: "-500.00" }),
      ]),
      { start: "2025-01-01", end: "2025-03-31" },
    );

    expect(points.map((point) => point.monthKey)).toEqual(["2025-01", "2025-02", "2025-03"]);
    expect(points[0].expenseCents).toBe(10_000);
    expect(points[1].expenseCents).toBe(0);
    expect(points[2].expenseCents).toBe(30_000);
    expect(points[2].incomeCents).toBe(50_000);
    expect(points[2].netCents).toBe(20_000);
  });
});

describe("account balances and cash position", () => {
  it("rolls a recorded opening balance forward through ledger activity", () => {
    const transactions = normalize([
      makeExpense({ transaction_date: "2025-01-15", total_amount: "500.00" }),
      makeExpense({ transaction_date: "2025-02-15", category: "Income", total_amount: "-2000.00" }),
    ]);

    const [row] = accountActivity({
      accounts: classifyAccounts({ bankAccounts: [checking] }),
      allTransactions: transactions,
      rangeTransactions: transactions,
      openingBalancesByAccountId: new Map([
        ["acct-checking", { cents: 1_000_000, date: "2024-12-31" }],
      ]),
    });

    expect(row.balanceCents).toBe(1_150_000);
    expect(row.balanceSource).toBe("opening_plus_activity");
  });

  it("prefers a reconciled statement balance over an onboarding figure", () => {
    const [row] = accountActivity({
      accounts: classifyAccounts({ bankAccounts: [checking] }),
      allTransactions: [],
      rangeTransactions: [],
      openingBalancesByAccountId: new Map([
        ["acct-checking", { cents: 1_000_000, date: "2024-12-31" }],
      ]),
      lastReconciledByAccountId: new Map([
        ["acct-checking", { cents: 2_500_000, date: "2025-05-31" }],
      ]),
    });

    expect(row.balanceCents).toBe(2_500_000);
    expect(row.balanceSource).toBe("reconciled_statement");
  });

  it("reports no balance rather than zero when nothing establishes one", () => {
    const [row] = accountActivity({
      accounts: classifyAccounts({ bankAccounts: [checking] }),
      allTransactions: [],
      rangeTransactions: [],
    });

    expect(row.balanceCents).toBeNull();
    expect(row.balanceSource).toBe("none");
  });

  it("subtracts card balances from the net liquid position", () => {
    const position = cashPosition([
      {
        account: classifyAccounts({ bankAccounts: [checking] })[0],
        balanceCents: 500_000,
        balanceSource: "opening_plus_activity",
        depositsCents: 0,
        withdrawalsCents: 0,
        transactionCount: 0,
        unreconciledCount: 0,
        missingReceiptCount: 0,
        pendingImportedCount: 0,
        lastActivity: null,
      },
      {
        account: classifyAccounts({ bankAccounts: [card] })[0],
        balanceCents: -120_000,
        balanceSource: "opening_plus_activity",
        depositsCents: 0,
        withdrawalsCents: 0,
        transactionCount: 0,
        unreconciledCount: 0,
        missingReceiptCount: 0,
        pendingImportedCount: 0,
        lastActivity: null,
      },
    ]);

    expect(position.totalCashCents).toBe(500_000);
    expect(position.creditCardBalanceCents).toBe(120_000);
    expect(position.netLiquidCents).toBe(380_000);
  });
});

describe("documentation metrics", () => {
  it("counts missing receipts only against expenses", () => {
    const metrics = documentationMetrics({
      transactions: normalize([
        makeExpense({ total_amount: "100.00" }),
        makeExpense({
          total_amount: "200.00",
          receipt_path: "dept/no-receipt",
          original_filename: "manual-entry",
        }),
        makeExpense({ category: "Income", total_amount: "-900.00", receipt_path: "dept/no-receipt" }),
      ]),
      accounts: accounts(),
      today: "2025-06-30",
    });

    expect(metrics.expenseCount).toBe(2);
    expect(metrics.missingReceiptCount).toBe(1);
    expect(metrics.receiptCompletionPercent).toBeCloseTo(50);
  });

  it("gives no completion percentage when there are no expenses", () => {
    const metrics = documentationMetrics({ transactions: [], accounts: accounts(), today: "2025-06-30" });
    expect(metrics.receiptCompletionPercent).toBeNull();
    expect(metrics.reconciliationCompletionPercent).toBeNull();
    expect(metrics.readiness.label).toBe("Incomplete");
  });

  it("flags transactions unreconciled for more than thirty days", () => {
    const metrics = documentationMetrics({
      transactions: normalize([
        makeExpense({ transaction_date: "2025-01-01", reconciliation_status: "unreconciled" }),
        makeExpense({ transaction_date: "2025-06-25", reconciliation_status: "unreconciled" }),
      ]),
      accounts: accounts(),
      today: "2025-06-30",
    });

    expect(metrics.unreconciledCount).toBe(2);
    expect(metrics.staleUnreconciledCount).toBe(1);
  });
});

describe("department isolation", () => {
  it("only ever sums the rows it was given", () => {
    // The data layer filters by department and RLS enforces it; the calculation
    // layer must never reach beyond its input, so a foreign row simply cannot
    // appear in a total.
    const ourRows = normalize([makeExpense({ total_amount: "100.00" })]);
    const rows = transactionsInRange(ourRows, { start: "2025-01-01", end: "2025-12-31" });

    expect(rows).toHaveLength(1);
    expect(categoryTotals({ current: rows }).reduce((sum, row) => sum + row.amountCents, 0)).toBe(10_000);
  });
});
