import { describe, expect, it } from "vitest";

import { buildMoneyInCategoryOptions } from "./categories";
import { buildSourceHistory } from "./history";
import { suggestMoneyInCategory, suggestMoneyInTwoPercent } from "./suggestion";
import type { ExpenseRecord } from "../types";

const DEPT = "dept-a";
const OTHER_DEPT = "dept-b";
const ALLOWED = buildMoneyInCategoryOptions([], [], DEPT);

let seq = 0;
function ledgerRow(overrides: Partial<ExpenseRecord>): ExpenseRecord {
  seq += 1;
  return {
    id: `row-${seq}`,
    department_id: DEPT,
    transaction_type: "income",
    transaction_date: "2026-01-15",
    created_at: "2026-01-15T00:00:00Z",
    total_amount: -100,
    payee: "Smith Family",
    merchant_name: "Smith Family",
    category: "Donations Received",
    uses_two_percent_funds: false,
    ...overrides,
  } as ExpenseRecord;
}

describe("category suggestion", () => {
  it("only ever suggests a valid Money In category", () => {
    const suggestion = suggestMoneyInCategory({
      payer: "Unknown Payer",
      aiCategory: "Office Supplies",
      aiConfidence: 0.99,
      allowedCategories: ALLOWED,
      ledgerRows: [],
      departmentId: DEPT,
    });
    expect(suggestion).not.toBeNull();
    expect(ALLOWED).toContain(suggestion!.category);
    expect(suggestion!.category).not.toBe("Office Supplies");
    expect(suggestion!.source).toBe("fallback");
  });

  it("never offers expense categories or transfers in the Money In picker", () => {
    expect(ALLOWED).toContain("Donations Received");
    expect(ALLOWED).toContain("NYS 2% Deposit");
    expect(ALLOWED).toContain("Other Income");
    expect(ALLOWED.map((c) => c.toLowerCase())).not.toContain("transfer");
    expect(ALLOWED).not.toContain("Fuel");
  });

  it("lets strong source history drive the next suggestion", () => {
    const history = [
      ledgerRow({ payee: "Lions Club", category: "Fundraising Income" }),
      ledgerRow({ payee: "Lions Club", category: "Fundraising Income" }),
      ledgerRow({ payee: "Lions Club", category: "Fundraising Income" }),
    ];
    const suggestion = suggestMoneyInCategory({
      payer: "Lions Club",
      memo: "donation",
      allowedCategories: ALLOWED,
      ledgerRows: history,
      departmentId: DEPT,
    });
    expect(suggestion?.category).toBe("Fundraising Income");
    expect(suggestion?.source).toBe("history");
  });

  it("never uses another department's source history", () => {
    const foreign = [
      ledgerRow({ department_id: OTHER_DEPT, payee: "Lions Club", category: "Grant" }),
      ledgerRow({ department_id: OTHER_DEPT, payee: "Lions Club", category: "Grant" }),
      ledgerRow({ department_id: OTHER_DEPT, payee: "Lions Club", category: "Grant" }),
    ];
    const suggestion = suggestMoneyInCategory({
      payer: "Lions Club",
      allowedCategories: ALLOWED,
      ledgerRows: foreign,
      departmentId: DEPT,
    });
    expect(suggestion?.source).not.toBe("history");
    expect(suggestion?.category).not.toBe("Grant");

    const sourceHistory = buildSourceHistory({ name: "Lions Club", ledgerRows: foreign, departmentId: DEPT });
    expect(sourceHistory).toBeNull();
  });

  it("does not let transfers shape source history", () => {
    const rows = [
      ledgerRow({ payee: "Savings", category: null, transaction_type: "transfer" }),
      ledgerRow({ payee: "Savings", category: null, transaction_type: "transfer" }),
    ];
    expect(buildSourceHistory({ name: "Savings", ledgerRows: rows, departmentId: DEPT })).toBeNull();
  });

  it("does not blindly treat a refund as ordinary income", () => {
    const suggestion = suggestMoneyInCategory({
      payer: "Firehouse Supply Co",
      memo: "Refund for returned merchandise",
      allowedCategories: ALLOWED,
      ledgerRows: [],
      departmentId: DEPT,
    });
    expect(suggestion?.category).toBe("Refund");
  });
});

describe("2% suggestion", () => {
  it("suggests 2% Funds for a foreign fire insurance check", () => {
    const suggestion = suggestMoneyInTwoPercent({
      payer: "Village of Springfield",
      memo: "Foreign Fire Insurance tax distribution 2026",
      ledgerRows: [],
      departmentId: DEPT,
    });
    expect(suggestion?.suggested).toBe(true);
    expect(suggestion?.reason).not.toMatch(/qualif/i);
  });

  it("does not treat an ordinary donation as 2%, even into the 2% account", () => {
    expect(
      suggestMoneyInTwoPercent({
        payer: "Smith Family",
        memo: "In memory of John Smith",
        category: "Donations Received",
        depositAccountIsTwoPercent: true,
        ledgerRows: [],
        departmentId: DEPT,
      }),
    ).toBeNull();
  });

  it("follows the department's own history for a recurring payer", () => {
    const history = [
      ledgerRow({ payee: "Town Clerk", category: "NYS 2% Deposit", uses_two_percent_funds: true }),
      ledgerRow({ payee: "Town Clerk", category: "NYS 2% Deposit", uses_two_percent_funds: true }),
    ];
    expect(
      suggestMoneyInTwoPercent({ payer: "Town Clerk", ledgerRows: history, departmentId: DEPT })?.suggested,
    ).toBe(true);
    expect(
      suggestMoneyInTwoPercent({ payer: "Town Clerk", ledgerRows: history, departmentId: OTHER_DEPT }),
    ).toBeNull();
  });
});
