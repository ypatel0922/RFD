import { describe, expect, it } from "vitest";

import { classifyAccounts } from "./accounts";
import { normalizeLedger } from "./classify";
import {
  carryoverForYear,
  summarizeTwoPercent,
  twoPercentByCategory,
} from "./two-percent";
import { makeBankAccount, makeExpense } from "./test-fixtures";
import type { AnalyticsExpenseRow, ClassifiedAccount } from "./types";

const twoPercentAccount = makeBankAccount({
  id: "acct-2pct",
  name: "Foreign Fire Savings",
  account_type: "Savings",
  is_two_percent_account: true,
  fund_type: "nys_2_percent",
  is_default: false,
});

const operatingAccount = makeBankAccount({
  id: "acct-operating",
  name: "Operating Checking",
  account_type: "Checking",
});

function accounts(): ClassifiedAccount[] {
  return classifyAccounts({ bankAccounts: [twoPercentAccount, operatingAccount] });
}

function normalize(expenses: AnalyticsExpenseRow[]) {
  return normalizeLedger({ expenses, accounts: accounts() }).transactions;
}

/** $8,000 received and $2,000 spent from the 2% account during 2025. */
function standardYear(): AnalyticsExpenseRow[] {
  return [
    makeExpense({
      transaction_date: "2025-02-01",
      bank_account_name: "Foreign Fire Savings",
      category: "NYS 2% Deposit",
      payee: "NYS Comptroller",
      total_amount: "-8000.00",
    }),
    makeExpense({
      transaction_date: "2025-04-10",
      bank_account_name: "Foreign Fire Savings",
      category: "Parade Uniforms",
      payee: "Uniform Depot",
      total_amount: "1500.00",
    }),
    makeExpense({
      transaction_date: "2025-05-10",
      bank_account_name: "Foreign Fire Savings",
      category: "Meeting Food",
      payee: "Corner Deli",
      total_amount: "500.00",
    }),
  ];
}

describe("2% identification", () => {
  it("counts transactions in a designated 2% account", () => {
    const summary = summarizeTwoPercent({
      transactions: normalize(standardYear()),
      accounts: accounts(),
      reportYear: 2025,
      targetPercent: 80,
      basis: "total_available",
      carryoverCents: 200_000,
      today: "2025-06-30",
    });

    expect(summary.receiptsCents).toBe(800_000);
    expect(summary.expendituresCents).toBe(200_000);
  });

  it("counts a transaction the treasurer tagged even in another account", () => {
    const summary = summarizeTwoPercent({
      transactions: normalize([
        makeExpense({
          transaction_date: "2025-03-01",
          bank_account_name: "Operating Checking",
          uses_two_percent_funds: true,
          total_amount: "450.00",
        }),
      ]),
      accounts: accounts(),
      reportYear: 2025,
      targetPercent: 80,
      basis: "total_available",
      carryoverCents: 0,
      today: "2025-06-30",
    });

    expect(summary.expendituresCents).toBe(45_000);
  });

  it("reports a setup state when no 2% account is designated", () => {
    const plainAccounts = classifyAccounts({ bankAccounts: [operatingAccount] });
    const summary = summarizeTwoPercent({
      transactions: normalizeLedger({ expenses: [makeExpense()], accounts: plainAccounts }).transactions,
      accounts: plainAccounts,
      reportYear: 2025,
      targetPercent: 80,
      basis: "total_available",
      carryoverCents: null,
      today: "2025-06-30",
    });

    expect(summary.setupState).toBe("no_account_configured");
  });

  it("distinguishes a configured account with no activity from no account at all", () => {
    const summary = summarizeTwoPercent({
      transactions: [],
      accounts: accounts(),
      reportYear: 2025,
      targetPercent: 80,
      basis: "total_available",
      carryoverCents: 0,
      today: "2025-06-30",
    });

    expect(summary.setupState).toBe("configured_no_activity");
  });
});

describe("carryover and receipts stay separate", () => {
  it("keeps the opening carryover out of current-year receipts", () => {
    const summary = summarizeTwoPercent({
      transactions: normalize(standardYear()),
      accounts: accounts(),
      reportYear: 2025,
      targetPercent: 80,
      basis: "total_available",
      carryoverCents: 300_000,
      today: "2025-06-30",
    });

    expect(summary.carryoverCents).toBe(300_000);
    expect(summary.receiptsCents).toBe(800_000);
    // Balance is carryover plus net movement: 300000 + 800000 - 200000.
    expect(summary.currentBalanceCents).toBe(900_000);
  });

  it("rolls a recorded opening balance forward to the close of the prior year", () => {
    const transactions = normalize([
      makeExpense({
        transaction_date: "2024-06-01",
        bank_account_name: "Foreign Fire Savings",
        total_amount: "1000.00",
      }),
      // Falls after the cutoff, so it must not affect the carryover.
      makeExpense({
        transaction_date: "2025-02-01",
        bank_account_name: "Foreign Fire Savings",
        total_amount: "9999.00",
      }),
    ]);

    const carryover = carryoverForYear({
      accounts: accounts(),
      transactions,
      reportYear: 2025,
      anchorsByAccountId: new Map([["acct-2pct", { cents: 500_000, date: "2023-12-31" }]]),
    });

    expect(carryover).toBe(400_000);
  });

  it("returns no carryover when nothing establishes one", () => {
    expect(
      carryoverForYear({
        accounts: accounts(),
        transactions: [],
        reportYear: 2025,
        anchorsByAccountId: new Map(),
      }),
    ).toBeNull();
  });
});

describe("utilization uses the denominator it displays", () => {
  it("measures against carryover plus receipts on the total-available basis", () => {
    const summary = summarizeTwoPercent({
      transactions: normalize(standardYear()),
      accounts: accounts(),
      reportYear: 2025,
      targetPercent: 80,
      basis: "total_available",
      carryoverCents: 200_000,
      today: "2025-06-30",
    });

    // 200000 spent of (200000 carryover + 800000 receipts) = 20%.
    expect(summary.denominatorCents).toBe(1_000_000);
    expect(summary.utilizationPercent).toBeCloseTo(20);
  });

  it("measures against this year's receipts alone on the receipts basis", () => {
    const summary = summarizeTwoPercent({
      transactions: normalize(standardYear()),
      accounts: accounts(),
      reportYear: 2025,
      targetPercent: 80,
      basis: "current_year_receipts",
      carryoverCents: 200_000,
      today: "2025-06-30",
    });

    // 200000 spent of 800000 receipts = 25%.
    expect(summary.denominatorCents).toBe(800_000);
    expect(summary.utilizationPercent).toBeCloseTo(25);
  });

  it("reports both denominators so the toggle never disagrees with itself", () => {
    const summary = summarizeTwoPercent({
      transactions: normalize(standardYear()),
      accounts: accounts(),
      reportYear: 2025,
      targetPercent: 80,
      basis: "total_available",
      carryoverCents: 200_000,
      today: "2025-06-30",
    });

    expect(summary.utilizationByBasis.total_available).toBeCloseTo(20);
    expect(summary.utilizationByBasis.current_year_receipts).toBeCloseTo(25);
  });

  it("gives no utilization rather than a wrong one when carryover is unknown", () => {
    const summary = summarizeTwoPercent({
      transactions: normalize(standardYear()),
      accounts: accounts(),
      reportYear: 2025,
      targetPercent: 80,
      basis: "total_available",
      carryoverCents: null,
      today: "2025-06-30",
    });

    expect(summary.utilizationPercent).toBeNull();
    expect(summary.currentBalanceCents).toBeNull();
  });

  it("never divides by zero when there is no 2% money at all", () => {
    const summary = summarizeTwoPercent({
      transactions: [],
      accounts: accounts(),
      reportYear: 2025,
      targetPercent: 80,
      basis: "current_year_receipts",
      carryoverCents: 0,
      today: "2025-06-30",
    });

    expect(summary.utilizationPercent).toBeNull();
    expect(Number.isFinite(summary.utilizationPercent ?? 0)).toBe(true);
  });
});

describe("transfers into a 2% account", () => {
  it("does not treat a transfer as a 2% receipt or expenditure", () => {
    const summary = summarizeTwoPercent({
      transactions: normalize([
        makeExpense({
          transaction_date: "2025-03-01",
          bank_account_name: "Foreign Fire Savings",
          payee: "Operating Checking",
          category: "Transfer",
          total_amount: "1000.00",
        }),
      ]),
      accounts: accounts(),
      reportYear: 2025,
      targetPercent: 80,
      basis: "total_available",
      carryoverCents: 100_000,
      today: "2025-06-30",
    });

    expect(summary.receiptsCents).toBe(0);
    expect(summary.expendituresCents).toBe(0);
  });
});

describe("projection and pacing", () => {
  it("projects year-end spending from the monthly average so far", () => {
    const summary = summarizeTwoPercent({
      transactions: normalize(standardYear()),
      accounts: accounts(),
      reportYear: 2025,
      targetPercent: 80,
      basis: "total_available",
      carryoverCents: 200_000,
      today: "2025-06-30",
    });

    // 200000 over 6 months averages 33333/month, projected across 6 more.
    expect(summary.monthsElapsed).toBe(6);
    expect(summary.monthlyAverageSpendCents).toBe(33_333);
    expect(summary.projectedYearEndSpendCents).toBe(399_998);
  });

  it("treats a closed prior year as fully elapsed", () => {
    const summary = summarizeTwoPercent({
      transactions: normalize(standardYear()),
      accounts: accounts(),
      reportYear: 2025,
      targetPercent: 80,
      basis: "total_available",
      carryoverCents: 200_000,
      today: "2026-03-01",
    });

    expect(summary.monthsElapsed).toBe(12);
    expect(summary.monthsRemaining).toBe(0);
    expect(summary.neededPerRemainingMonthCents).toBeNull();
  });
});

describe("2% readiness", () => {
  it("reports open documentation items", () => {
    const summary = summarizeTwoPercent({
      transactions: normalize([
        makeExpense({
          transaction_date: "2025-04-10",
          bank_account_name: "Foreign Fire Savings",
          receipt_path: "dept/no-receipt",
          original_filename: "manual-entry",
          category: null,
          reconciliation_status: "unreconciled",
          total_amount: "300.00",
        }),
      ]),
      accounts: accounts(),
      reportYear: 2025,
      targetPercent: 80,
      basis: "total_available",
      carryoverCents: 100_000,
      today: "2025-06-30",
    });

    expect(summary.missingReceiptCount).toBe(1);
    expect(summary.uncategorizedCount).toBe(1);
    expect(summary.unreconciledCount).toBe(1);
    expect(summary.readiness.label).toBe("Minor items");
  });

  it("reports ready when nothing is outstanding", () => {
    const summary = summarizeTwoPercent({
      transactions: normalize(standardYear()),
      accounts: accounts(),
      reportYear: 2025,
      targetPercent: 80,
      basis: "total_available",
      carryoverCents: 100_000,
      today: "2025-06-30",
    });

    expect(summary.readiness.label).toBe("Ready");
    expect(summary.readiness.openItemCount).toBe(0);
  });
});

describe("2% spending by category", () => {
  it("splits expenditure by category with shares that sum to 100", () => {
    const rows = twoPercentByCategory({
      current: normalize(standardYear()),
      reportYear: 2025,
    });

    expect(rows.map((row) => row.category)).toEqual(["Parade Uniforms", "Meeting Food"]);
    expect(rows[0].amountCents).toBe(150_000);
    expect(rows[0].percentOfExpenditures).toBeCloseTo(75);
    expect(rows[1].percentOfExpenditures).toBeCloseTo(25);
  });

  it("returns nothing rather than a zero row when there is no activity", () => {
    expect(twoPercentByCategory({ current: [], reportYear: 2025 })).toEqual([]);
  });
});
