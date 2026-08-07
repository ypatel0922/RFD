import { describe, expect, it } from "vitest";

import { classifyAccounts } from "./accounts";
import {
  normalizeLedger,
  rowHasReceipt,
  splitImportedActivity,
} from "./classify";
import { totalsFor } from "./aggregate";
import {
  makeBankAccount,
  makeExpense,
  makeExternalTransaction,
} from "./test-fixtures";
import type { AnalyticsExpenseRow, ClassifiedAccount } from "./types";

const checking = makeBankAccount({
  id: "acct-checking",
  name: "Operating Checking",
  account_type: "Checking",
});
const savings = makeBankAccount({
  id: "acct-savings",
  name: "Capital Savings",
  account_type: "Savings",
  is_default: false,
  fund_type: "capital_reserve",
});
const card = makeBankAccount({
  id: "acct-card",
  name: "Department Visa",
  account_type: "Credit Card",
  is_default: false,
  fund_type: null,
});

function accountsFor(): ClassifiedAccount[] {
  return classifyAccounts({ bankAccounts: [checking, savings, card] });
}

function classifyAll(expenses: AnalyticsExpenseRow[]) {
  return normalizeLedger({ expenses, accounts: accountsFor() }).transactions;
}

describe("account classification", () => {
  it("reads kind from a recorded account type rather than the account name", () => {
    const accounts = classifyAccounts({
      bankAccounts: [
        makeBankAccount({ id: "a", name: "2% Checking", account_type: "Checking" }),
        makeBankAccount({ id: "b", name: "Rewards Checking Card", account_type: "Credit Card" }),
      ],
    });

    expect(accounts[0].kind).toBe("asset");
    expect(accounts[1].kind).toBe("liability");
  });

  it("leaves an account unclassified when nobody has recorded a type", () => {
    const [account] = classifyAccounts({
      bankAccounts: [makeBankAccount({ account_type: null, fund_type: null })],
    });

    expect(account.kind).toBe("unclassified");
    expect(account.kindSource).toBe("unknown");
  });

  it("falls back to the onboarding account type, then to Plaid", () => {
    const viaOnboarding = classifyAccounts({
      bankAccounts: [makeBankAccount({ id: "a", name: "Card", account_type: null })],
      openingBalances: [
        {
          account_id: "a",
          account_name: "Card",
          account_type: "Credit Card",
          beginning_balance: "0",
          balance_date: "2024-12-31",
        },
      ],
    });
    expect(viaOnboarding[0].kind).toBe("liability");
    expect(viaOnboarding[0].kindSource).toBe("opening_balance");

    const viaPlaid = classifyAccounts({
      bankAccounts: [makeBankAccount({ id: "b", name: "Linked Card", account_type: null })],
      externalAccounts: [
        { id: "ext", name: "Linked Card", mask: null, type: "credit", subtype: "credit card" },
      ],
    });
    expect(viaPlaid[0].kind).toBe("liability");
    expect(viaPlaid[0].kindSource).toBe("plaid");
  });

  it("never treats a 2% designation as an account kind", () => {
    const [account] = classifyAccounts({
      bankAccounts: [
        makeBankAccount({ account_type: "Savings", is_two_percent_account: true, fund_type: "nys_2_percent" }),
      ],
    });

    expect(account.kind).toBe("asset");
    expect(account.fund).toBe("two_percent");
    expect(account.isTwoPercent).toBe(true);
  });
});

describe("internal transfers", () => {
  it("excludes a transfer between two department accounts from income and expenses", () => {
    const transactions = classifyAll([
      makeExpense({
        payee: "Capital Savings",
        category: "Transfer",
        bank_account_name: "Operating Checking",
        total_amount: "5000.00",
      }),
    ]);

    expect(transactions[0].classification).toBe("internal_transfer");

    const totals = totalsFor(transactions);
    expect(totals.incomeCents).toBe(0);
    expect(totals.expenseCents).toBe(0);
    expect(totals.internalTransferCents).toBe(500_000);
  });

  it("recognises a transfer from its description when the payee is not an account", () => {
    const transactions = classifyAll([
      makeExpense({
        payee: "Community Bank",
        category: "Banking",
        description: "Online transfer to reserve",
        total_amount: "250.00",
      }),
    ]);

    expect(transactions[0].classification).toBe("internal_transfer");
  });

  it("does not mistake a vendor whose name merely contains an account word", () => {
    const transactions = classifyAll([
      makeExpense({ payee: "Capital Savings Diner", total_amount: "42.00" }),
    ]);

    expect(transactions[0].classification).toBe("expense");
  });
});

describe("credit cards", () => {
  it("counts a purchase charged to a card as an expense", () => {
    const transactions = classifyAll([
      makeExpense({
        payee: "Fuel Depot",
        category: "Fuel",
        bank_account_name: "Department Visa",
        total_amount: "180.00",
      }),
    ]);

    expect(transactions[0].classification).toBe("expense");
    expect(totalsFor(transactions).expenseCents).toBe(18_000);
  });

  it("does not count a card payment from checking as an expense", () => {
    const transactions = classifyAll([
      makeExpense({
        payee: "Department Visa",
        category: "Card Payment",
        bank_account_name: "Operating Checking",
        total_amount: "180.00",
      }),
    ]);

    expect(transactions[0].classification).toBe("credit_card_payment");

    const totals = totalsFor(transactions);
    expect(totals.expenseCents).toBe(0);
    expect(totals.creditCardPaymentCents).toBe(18_000);
  });

  it("does not count the purchase and its later card payment twice", () => {
    const transactions = classifyAll([
      makeExpense({
        payee: "Fuel Depot",
        category: "Fuel",
        bank_account_name: "Department Visa",
        total_amount: "180.00",
      }),
      makeExpense({
        payee: "Department Visa",
        description: "Credit card payment",
        bank_account_name: "Operating Checking",
        total_amount: "180.00",
      }),
    ]);

    expect(totalsFor(transactions).expenseCents).toBe(18_000);
  });

  it("recognises a card payment described in words without a matching account", () => {
    const transactions = classifyAll([
      makeExpense({
        payee: "Big Bank Card Services",
        description: "Autopay statement payment",
        total_amount: "500.00",
      }),
    ]);

    expect(transactions[0].classification).toBe("credit_card_payment");
  });
});

describe("refunds and credits", () => {
  it("treats a refund as a reduction in spending, not as income", () => {
    const transactions = classifyAll([
      makeExpense({ payee: "Firehouse Supply Co", total_amount: "300.00" }),
      makeExpense({
        payee: "Firehouse Supply Co",
        description: "Refund for returned hose",
        total_amount: "-120.00",
      }),
    ]);

    expect(transactions[1].classification).toBe("refund");

    const totals = totalsFor(transactions);
    expect(totals.grossExpenseCents).toBe(30_000);
    expect(totals.refundCents).toBe(12_000);
    expect(totals.expenseCents).toBe(18_000);
    expect(totals.incomeCents).toBe(0);
  });

  it("keeps a refund amount positive in the total rather than showing a negative", () => {
    const transactions = classifyAll([
      makeExpense({ description: "Vendor refund", total_amount: "-75.50" }),
    ]);

    expect(transactions[0].magnitudeCents).toBe(7_550);
    expect(totalsFor(transactions).refundCents).toBe(7_550);
  });

  it("still treats an ordinary deposit as income", () => {
    const transactions = classifyAll([
      makeExpense({ category: "Income", payee: "Town of Riverhead", total_amount: "-2500.00" }),
    ]);

    expect(transactions[0].classification).toBe("income");
    expect(totalsFor(transactions).incomeCents).toBe(250_000);
  });
});

describe("imported bank activity", () => {
  it("drops an imported row that is already linked to a ledger entry", () => {
    const result = splitImportedActivity([
      makeExternalTransaction({ expense_id: "expense-1", match_status: "matched" }),
      makeExternalTransaction({ expense_id: null }),
    ]);

    expect(result.matchedExpenseIds.has("expense-1")).toBe(true);
    expect(result.unmatched).toHaveLength(1);
  });

  it("does not count a pending row and its posted version twice", () => {
    const result = splitImportedActivity([
      makeExternalTransaction({
        id: "pending",
        pending: true,
        posted_date: "2025-06-14",
        description: "FIREHOUSE SUPPLY CO",
        amount: "100.00",
      }),
      makeExternalTransaction({
        id: "posted",
        pending: false,
        posted_date: "2025-06-16",
        description: "FIREHOUSE SUPPLY CO",
        amount: "100.00",
      }),
    ]);

    expect(result.pending).toHaveLength(0);
    expect(result.unmatched).toHaveLength(1);
  });

  it("keeps a pending row that has not posted yet", () => {
    const result = splitImportedActivity([
      makeExternalTransaction({ id: "pending", pending: true, amount: "62.00" }),
    ]);

    expect(result.pending).toHaveLength(1);
  });

  it("keeps pending amounts out of the ledger totals entirely", () => {
    const { transactions, imported } = normalizeLedger({
      expenses: [makeExpense({ total_amount: "100.00" })],
      externalTransactions: [
        makeExternalTransaction({ pending: true, amount: "999.00", description: "PENDING CHARGE" }),
      ],
      accounts: accountsFor(),
    });

    expect(totalsFor(transactions).expenseCents).toBe(10_000);
    expect(imported.pending).toHaveLength(1);
  });
});

describe("receipt detection", () => {
  it("counts a stored receipt file as present", () => {
    expect(rowHasReceipt({ receipt_path: "dept/2025/06/e/r.jpg", original_filename: "r.jpg" })).toBe(true);
  });

  it("treats placeholder paths as missing", () => {
    expect(rowHasReceipt({ receipt_path: "dept/no-receipt", original_filename: "manual-entry" })).toBe(false);
    expect(rowHasReceipt({ receipt_path: "dept/manual/x", original_filename: "x" })).toBe(false);
    expect(rowHasReceipt({ receipt_path: "dept/statement-import/x", original_filename: "x" })).toBe(false);
    expect(rowHasReceipt({ receipt_path: null, original_filename: null })).toBe(false);
  });
});
