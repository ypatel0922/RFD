import { describe, expect, it } from "vitest";

import { classifyAccounts } from "./accounts";
import { normalizeLedger } from "./classify";
import { buildPeriod } from "./date-range";
import { EMPTY_SOURCE_DATA, runAnalytics } from "./engine";
import { moneyInBySource } from "./money-in";
import { makeBankAccount, makeExpense, makeOpeningBalance, makeSettings } from "./test-fixtures";
import { summarizeTwoPercent } from "./two-percent";
import type { AnalyticsExpenseRow } from "./types";

const TODAY = "2025-06-30";

const operating = makeBankAccount({ id: "acct-operating", name: "Operating Checking" });
const twoPercentAccount = makeBankAccount({
  id: "acct-2pct",
  name: "Foreign Fire Savings",
  account_type: "Savings",
  is_two_percent_account: true,
  fund_type: "nys_2_percent",
  is_default: false,
});

function accounts() {
  return classifyAccounts({ bankAccounts: [operating, twoPercentAccount] });
}

function normalize(expenses: AnalyticsExpenseRow[]) {
  return normalizeLedger({ expenses, accounts: accounts() }).transactions;
}

function twoPercentReceipts(expenses: AnalyticsExpenseRow[]) {
  return summarizeTwoPercent({
    transactions: normalize(expenses),
    accounts: accounts(),
    reportYear: 2025,
    targetPercent: 80,
    basis: "total_available",
    carryoverCents: 0,
    today: TODAY,
  }).receiptsCents;
}

function moneyIn(overrides: Partial<AnalyticsExpenseRow>): AnalyticsExpenseRow {
  return makeExpense({
    transaction_type: "income",
    total_amount: "-500.00",
    category: "Donations Received",
    payee: "Smith Family",
    receipt_path: "dept/manual/x/no-receipt",
    original_filename: "manual-entry",
    ...overrides,
  });
}

function transferLegs(bankFrom: string, bankTo: string, amount: string): AnalyticsExpenseRow[] {
  return [
    makeExpense({
      transaction_type: "transfer",
      total_amount: amount,
      category: null,
      payee: bankTo,
      bank_account_name: bankFrom,
      description: "Quarterly sweep",
    }),
    makeExpense({
      transaction_type: "transfer",
      total_amount: `-${amount}`,
      category: null,
      payee: bankFrom,
      bank_account_name: bankTo,
      description: "Quarterly sweep",
    }),
  ];
}

describe("2% Fund Intelligence", () => {
  it("counts a confirmed 2% receipt as 2% received", () => {
    const receipt = moneyIn({
      category: "NYS 2% Deposit",
      payee: "Village Clerk",
      bank_account_name: "Foreign Fire Savings",
      uses_two_percent_funds: true,
      total_amount: "-8000.00",
      transaction_date: "2025-03-01",
    });
    expect(twoPercentReceipts([receipt])).toBe(800_000);
  });

  it("does not count ordinary income deposited to the 2% account as 2% received", () => {
    const donation = moneyIn({
      bank_account_name: "Foreign Fire Savings",
      uses_two_percent_funds: false,
      transaction_date: "2025-03-01",
    });
    expect(twoPercentReceipts([donation])).toBe(0);
  });

  it("does not count an internal transfer into the 2% account as 2% received", () => {
    expect(twoPercentReceipts(transferLegs("Operating Checking", "Foreign Fire Savings", "3000.00"))).toBe(0);
  });
});

describe("Money In in cash flow and totals", () => {
  function run(expenses: AnalyticsExpenseRow[]) {
    return runAnalytics({
      data: {
        ...EMPTY_SOURCE_DATA,
        bankAccounts: [operating, twoPercentAccount],
        openingBalances: [makeOpeningBalance({ account_id: "acct-operating" })],
        expenses,
      },
      period: buildPeriod({ preset: "year_to_date", comparisonMode: "none", today: TODAY }),
      settings: makeSettings(),
      today: TODAY,
    });
  }

  it("feeds a donation into income, cash flow and Money In by source", () => {
    const result = run([moneyIn({ transaction_date: "2025-04-02" })]);
    expect(result.totals.incomeCents).toBe(50_000);
    const april = result.cashFlow.months.find((m) => m.monthKey === "2025-04");
    expect(april?.inflowCents).toBe(50_000);
    expect(result.moneyInBySource).toEqual([
      expect.objectContaining({ key: "donations", cents: 50_000, count: 1 }),
    ]);
  });

  it("keeps internal transfers out of income and expenses", () => {
    const result = run(transferLegs("Savings Reserve", "Operating Checking", "5000.00").map((row) => ({
      ...row,
      transaction_date: "2025-04-05",
    })));
    expect(result.totals.incomeCents).toBe(0);
    expect(result.totals.expenseCents).toBe(0);
    expect(result.moneyInBySource).toEqual([]);
  });

  it("nets a recorded refund against spending instead of counting it as income", () => {
    const result = run([
      makeExpense({ total_amount: "300.00", transaction_date: "2025-04-01" }),
      moneyIn({ transaction_type: "refund", category: "Refund", payee: "Firehouse Supply Co", total_amount: "-100.00", transaction_date: "2025-04-03" }),
    ]);
    expect(result.totals.incomeCents).toBe(0);
    expect(result.totals.expenseCents).toBe(20_000);
  });

  it("lets a confirmed type outrank wording: a grant memo saying 'transfer' is still income", () => {
    const [row] = normalize([moneyIn({ category: "Grant", description: "Grant funds transfer from county" })]);
    expect(row.classification).toBe("income");
  });
});

describe("existing expense analytics", () => {
  it("classifies legacy untyped rows exactly as before", () => {
    const rows = normalize([
      makeExpense({ total_amount: "120.00" }),
      makeExpense({ total_amount: "-50.00", description: "Refund for returned item" }),
      makeExpense({ total_amount: "-900.00", category: "NYS 2% Deposit", bank_account_name: "Foreign Fire Savings" }),
      makeExpense({ total_amount: "400.00", description: "Online transfer to savings" }),
    ]);
    expect(rows.map((r) => r.classification)).toEqual(["expense", "refund", "income", "internal_transfer"]);
    // Legacy inflows in the 2% account keep the account rule.
    expect(rows[2].isTwoPercent).toBe(true);
  });

  it("groups Money In by source and leaves expenses out", () => {
    const rows = normalize([
      moneyIn({ category: "Hall / Facility Rental", total_amount: "-200.00" }),
      moneyIn({ category: "Donations Received", total_amount: "-75.00" }),
      makeExpense({ total_amount: "60.00" }),
    ]);
    expect(moneyInBySource(rows).map((r) => [r.key, r.cents])).toEqual([
      ["hall_rentals", 20_000],
      ["donations", 7_500],
    ]);
  });
});
