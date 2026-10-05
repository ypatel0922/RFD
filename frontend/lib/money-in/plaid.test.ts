import { describe, expect, it } from "vitest";

import { splitImportedActivity } from "../analytics/classify";
import { makeExternalTransaction } from "../analytics/test-fixtures";
import type { ExpenseRecord } from "../types";
import {
  canAutoMatchBankRow,
  classifyBankCredit,
  findMoneyInBankMatches,
  findTransferPair,
  isOpenBankCredit,
  planPendingSupersession,
  scoreMoneyInBankMatch,
  type BankAccountRef,
  type BankActivityRow,
} from "./plaid";

const DEPT = "dept-a";

const accountsById = new Map<string, BankAccountRef>([
  ["ext-checking", { id: "ext-checking", name: "Operating Checking" }],
  ["ext-2pct", { id: "ext-2pct", name: "Foreign Fire Savings" }],
  ["ext-savings", { id: "ext-savings", name: "Savings" }],
]);

let seq = 0;
function bankRow(overrides: Partial<BankActivityRow> = {}): BankActivityRow {
  seq += 1;
  return {
    id: `bank-${seq}`,
    external_transaction_id: `plaid-${seq}`,
    external_account_id: "ext-checking",
    posted_date: "2026-03-12",
    description: "DEPOSIT",
    amount: -250,
    pending: false,
    expense_id: null,
    match_status: "unmatched",
    ...overrides,
  };
}

function moneyIn(overrides: Partial<ExpenseRecord> = {}): ExpenseRecord {
  seq += 1;
  return {
    id: `record-${seq}`,
    department_id: DEPT,
    transaction_type: "income",
    transaction_date: "2026-03-09",
    total_amount: -250,
    payee: "Smith Family",
    bank_account_name: "Operating Checking",
    reconciliation_status: "pending_bank_match",
    bank_transaction_id: null,
    payment_reference: "1042",
    deposit_date: null,
    ...overrides,
  } as ExpenseRecord;
}

describe("incoming Plaid credits", () => {
  it("recognizes an open credit and gives it a first classification", () => {
    expect(isOpenBankCredit(bankRow())).toBe(true);
    expect(isOpenBankCredit(bankRow({ amount: 42 }))).toBe(false);
    expect(isOpenBankCredit(bankRow({ match_status: "superseded" }))).toBe(false);
    expect(classifyBankCredit("ONLINE TRANSFER FROM SAVINGS")).toBe("transfer");
    expect(classifyBankCredit("INTEREST PAYMENT")).toBe("interest");
    expect(classifyBankCredit("AMAZON REFUND")).toBe("refund");
    expect(classifyBankCredit("MOBILE DEPOSIT")).toBe("income");
  });

  it("never auto-matches incoming money, and only matches outflows to outflows", () => {
    expect(canAutoMatchBankRow(-250, { total_amount: -250, transaction_type: "income" })).toBe(false);
    expect(canAutoMatchBankRow(-250, { total_amount: 250 })).toBe(false);
    expect(canAutoMatchBankRow(250, { total_amount: -250 })).toBe(false);
    expect(canAutoMatchBankRow(250, { total_amount: 250, transaction_type: "transfer" })).toBe(false);
    expect(canAutoMatchBankRow(250, { total_amount: 250 })).toBe(true);
  });
});

describe("matching a record to its bank deposit", () => {
  it("offers a possible match on amount, account, date window and check number", () => {
    const credit = bankRow({ description: "DEPOSIT CHECK 1042" });
    const match = scoreMoneyInBankMatch(credit, moneyIn(), { accountsById });
    expect(match).not.toBeNull();
    expect(match!.score).toBeGreaterThanOrEqual(0.8);
    expect(match!.reasons).toContain("Check #1042");
  });

  it("respects the destination account", () => {
    const credit = bankRow({ external_account_id: "ext-2pct" });
    expect(scoreMoneyInBankMatch(credit, moneyIn(), { accountsById })).toBeNull();
  });

  it("requires the exact amount and a plausible deposit date", () => {
    expect(scoreMoneyInBankMatch(bankRow({ amount: -250.01 }), moneyIn(), { accountsById })).toBeNull();
    expect(scoreMoneyInBankMatch(bankRow({ posted_date: "2026-05-01" }), moneyIn(), { accountsById })).toBeNull();
  });

  it("never offers an expense or an already matched record", () => {
    const records = [
      moneyIn({ transaction_type: null, total_amount: 250 }),
      moneyIn({ reconciliation_status: "matched" }),
      moneyIn({ department_id: "dept-b" }),
    ];
    expect(findMoneyInBankMatches(bankRow(), records, { accountsById, departmentId: DEPT })).toEqual([]);
  });

  it("counts a record and its bank row once after they are linked", () => {
    const record = moneyIn();
    const linkedBankRow = makeExternalTransaction({ amount: "-250.00", expense_id: record.id, match_status: "matched" });
    const activity = splitImportedActivity([linkedBankRow]);
    expect(activity.unmatched).toHaveLength(0);
    expect(activity.pending).toHaveLength(0);
    expect(activity.matchedExpenseIds.has(record.id)).toBe(true);
  });
});

describe("pending to posted", () => {
  it("moves the pending row's link to the posted row and supersedes the pending row", () => {
    const existing = new Map([["plaid-pending", { id: "bank-pending", expense_id: "record-1", match_status: "matched" }]]);
    const plans = planPendingSupersession(
      [{ transaction_id: "plaid-posted", pending_transaction_id: "plaid-pending", pending: false }],
      existing,
    );
    expect(plans).toEqual([
      { postedExternalId: "plaid-posted", pendingRowId: "bank-pending", inheritExpenseId: "record-1", inheritMatchStatus: "matched" },
    ]);
  });

  it("does not double count a superseded pending credit in analytics", () => {
    const pending = makeExternalTransaction({ amount: "-250.00", pending: true, match_status: "superseded", description: "PENDING DEPOSIT" });
    const posted = makeExternalTransaction({ amount: "-250.00", pending: false, description: "DEPOSIT" });
    const activity = splitImportedActivity([pending, posted]);
    expect(activity.pending).toHaveLength(0);
    expect(activity.unmatched).toEqual([posted]);
  });
});

describe("internal transfer pairs", () => {
  it("offers a transfer only when the pairing is unambiguous", () => {
    const credit = bankRow({ amount: -5000, external_account_id: "ext-checking" });
    const debit = bankRow({ amount: 5000, external_account_id: "ext-savings", posted_date: "2026-03-11" });
    expect(findTransferPair(credit, [credit, debit])?.debit.id).toBe(debit.id);

    const secondDebit = bankRow({ amount: 5000, external_account_id: "ext-2pct", posted_date: "2026-03-12" });
    expect(findTransferPair(credit, [credit, debit, secondDebit])).toBeNull();
  });

  it("never pairs two rows in the same account", () => {
    const credit = bankRow({ amount: -5000 });
    const debit = bankRow({ amount: 5000 });
    expect(findTransferPair(credit, [credit, debit])).toBeNull();
  });
});
