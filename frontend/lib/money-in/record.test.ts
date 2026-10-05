import { describe, expect, it } from "vitest";

import {
  buildMoneyInDocumentPath,
  buildMoneyInLedgerRow,
  buildTransferLedgerRows,
  emptyMoneyInForm,
  markDepositedPatch,
  moneyInStatus,
  validateMoneyIn,
} from "./record";

const DEPT = "11111111-1111-4111-8111-111111111111";
const ACTOR = { id: "user-1", email: "treasurer@example.org", label: "Treasurer (treasurer@example.org)" };
const NOW = new Date("2026-03-10T15:00:00Z");

function donation(overrides = {}) {
  return emptyMoneyInForm({
    date_received: "2026-03-09",
    payer: "Smith Family",
    amount_cents: 25_000,
    deposit_account: "Operating Checking",
    category: "Donations Received",
    payment_method: "check",
    check_number: "1042",
    deposit_status: "received",
    memo: "In memory of John Smith",
    ...overrides,
  });
}

describe("manual Money In", () => {
  it("records a manual donation as a typed inflow in the canonical ledger", () => {
    const row = buildMoneyInLedgerRow({ id: "row-1", departmentId: DEPT, values: donation(), actor: ACTOR, now: NOW });

    expect(row.department_id).toBe(DEPT);
    expect(row.transaction_type).toBe("income");
    expect(row.total_amount).toBe(-250);
    expect(row.payee).toBe("Smith Family");
    expect(row.category).toBe("Donations Received");
    expect(row.bank_account_name).toBe("Operating Checking");
    expect(row.payment_reference).toBe("1042");
    expect(row.deposit_status).toBe("received");
    expect(row.uses_two_percent_funds).toBe(false);
    expect(row.reconciliation_status).toBe("pending_bank_match");
    expect(row.receipt_path).toBe(`${DEPT}/manual/row-1/no-receipt`);
  });

  it("requires the review fields before saving", () => {
    expect(validateMoneyIn(donation({ payer: "" }), { hasBankAccounts: true })?.field).toBe("payer");
    expect(validateMoneyIn(donation({ amount_cents: 0 }), { hasBankAccounts: true })?.field).toBe("amount");
    expect(validateMoneyIn(donation(), { hasBankAccounts: true })).toBeNull();
  });

  it("keeps the user's 2% decision: an override to 'not 2%' is saved as not 2%", () => {
    const row = buildMoneyInLedgerRow({
      id: "row-2",
      departmentId: DEPT,
      values: donation({ category: "NYS 2% Deposit", uses_two_percent_funds: false }),
      actor: ACTOR,
      suggestion: { suggestedCategory: "NYS 2% Deposit", suggestedCategorySource: "document", twoPercentSuggested: true },
      now: NOW,
    });
    expect(row.uses_two_percent_funds).toBe(false);
    const details = row.money_in_details as Record<string, unknown>;
    expect(details.two_percent_suggested).toBe(true);
    expect(details.two_percent_confirmed).toBe(false);
  });

  it("records the category override against the suggestion for the audit trail", () => {
    const row = buildMoneyInLedgerRow({
      id: "row-3",
      departmentId: DEPT,
      values: donation({ category: "Fundraising Income" }),
      actor: ACTOR,
      suggestion: { suggestedCategory: "Donations Received", suggestedCategorySource: "ai", twoPercentSuggested: false },
      now: NOW,
    });
    expect((row.money_in_details as Record<string, unknown>).category_overridden).toBe(true);
  });

  it("types a refund as a refund, never as ordinary income, and never as 2%", () => {
    const row = buildMoneyInLedgerRow({
      id: "row-4",
      departmentId: DEPT,
      values: donation({ payer: "Firehouse Supply Co", category: "Refund", uses_two_percent_funds: true }),
      actor: ACTOR,
      now: NOW,
    });
    expect(row.transaction_type).toBe("refund");
    expect(row.uses_two_percent_funds).toBe(false);
  });

  it("never persists routing or account numbers the user pasted into the memo or check field", () => {
    const row = buildMoneyInLedgerRow({
      id: "row-5",
      departmentId: DEPT,
      values: donation({ memo: "Routing 021000021 account 123456789012 thanks", check_number: "⑆021000021⑆ 123456789012⑈ 1042" }),
      actor: ACTOR,
      now: NOW,
    });
    expect(String(row.description)).not.toMatch(/021000021|123456789012/);
    expect(row.payment_reference).toBeNull();
  });
});

describe("deposits without a bank feed", () => {
  it("lets a manual department mark funds deposited and shows the right lifecycle", () => {
    const received = { reconciliation_status: "pending_bank_match" as const, deposit_status: "received" as const };
    expect(moneyInStatus(received, { hasBankFeed: false }).label).toBe("Awaiting deposit");

    const patch = markDepositedPatch({ depositAccount: "Operating Checking", depositDate: "2026-03-11" });
    expect(patch).toEqual({ deposit_status: "deposited", deposit_date: "2026-03-11", bank_account_name: "Operating Checking" });

    const deposited = { ...received, deposit_status: "deposited" as const };
    expect(moneyInStatus(deposited, { hasBankFeed: false }).label).toBe("Deposited");
    expect(moneyInStatus(deposited, { hasBankFeed: true }).label).toBe("Awaiting bank match");
    expect(moneyInStatus({ ...deposited, reconciliation_status: "matched" as const }, { hasBankFeed: true }).label).toBe("Matched");
  });
});

describe("internal transfers", () => {
  it("records two linked transfer legs with no income category", () => {
    const [out, into] = buildTransferLedgerRows({
      outId: "out-1",
      inId: "in-1",
      groupId: "group-1",
      departmentId: DEPT,
      values: emptyMoneyInForm({
        mode: "transfer",
        date_received: "2026-03-09",
        amount_cents: 500_000,
        transfer_from_account: "Savings",
        deposit_account: "Operating Checking",
      }),
      actor: ACTOR,
      now: NOW,
    });
    expect(out.transaction_type).toBe("transfer");
    expect(into.transaction_type).toBe("transfer");
    expect(out.transfer_group_id).toBe(into.transfer_group_id);
    expect(out.total_amount).toBe(5000);
    expect(into.total_amount).toBe(-5000);
    expect(out.category).toBeNull();
    expect(into.category).toBeNull();
    expect(into.uses_two_percent_funds).toBe(false);
  });
});

describe("check storage", () => {
  it("stores check images under the department's private folder", () => {
    const path = buildMoneyInDocumentPath({
      departmentId: DEPT,
      expenseId: "row-1",
      documentId: "doc-1",
      extension: ".jpg",
      now: NOW,
    });
    // Storage RLS authorizes by the first folder segment, so it must be the department.
    expect(path.split("/")[0]).toBe(DEPT);
    expect(path).toBe(`${DEPT}/money-in/2026/03/row-1/doc-1.jpg`);
    expect(path).not.toMatch(/^public\//);
  });
});
