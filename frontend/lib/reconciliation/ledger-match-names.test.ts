/**
 * How Hallix name fields become matcher needles.
 *
 * Receipts often leave a clean merchant_name while payee or description carries
 * extra OCR / memo text. Matching must use each field on its own — concatenating
 * them makes containsVendorName demand words the bank never prints.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_DATE_TOLERANCE_DAYS } from "./config";
import { toLedgerCandidate } from "./ledger";
import { matchStatementToLedger } from "./matching";
import { consolidatedLines, dollars } from "./test-fixtures";

function runJuly(candidates: ReturnType<typeof toLedgerCandidate>[], sign: "debit" | "credit" = "debit") {
  return matchStatementToLedger({
    lines: consolidatedLines([
      {
        postedDate: "2026-07-02",
        originalDescription: "SQ *EMPLOYEES ONLY LLC NEW YORK NY",
        signedAmountCents: sign === "debit" ? -dollars(54) : dollars(54),
      },
    ]),
    candidates,
    statementStartDate: "2026-07-01",
    statementEndDate: "2026-07-31",
    selectedAccountName: "Operating Checking",
    dateToleranceDays: DEFAULT_DATE_TOLERANCE_DAYS,
  });
}

const baseRow = {
  id: "exp-employees",
  transaction_date: "2026-07-02",
  total_amount: "54.00",
  payee: null as string | null,
  merchant_name: "Employee's Only" as string | null,
  description: null as string | null,
  category: "Meals",
  fund: null,
  payment_reference: null,
  bank_account_name: "Operating Checking",
  reconciliation_status: null,
  reconciled_at: null,
};

describe("Employees Only — Hallix name fields vs Square bank text", () => {
  it("matches when merchant_name is clean and description has unrelated memo words", () => {
    const candidate = toLedgerCandidate({
      ...baseRow,
      description: "Team dinner downtown table 4",
    });
    const result = runJuly([candidate]);
    expect(result.lines[0].matchStatus).toBe("auto_matched");
    expect(result.lines[0].matchedExpenseId).toBe("exp-employees");
  });

  it("matches merchant_name even when payee is a different cardholder-style label", () => {
    const candidate = toLedgerCandidate({
      ...baseRow,
      payee: "Chase Sapphire",
      merchant_name: "Employee's Only",
    });
    const result = runJuly([candidate]);
    expect(result.lines[0].matchedExpenseId).toBe("exp-employees");
    expect(result.lines[0].matchStatus).toBe("auto_matched");
  });

  it("still surfaces a sign-flipped Square charge when the merchant name agrees", () => {
    const candidate = toLedgerCandidate(baseRow);
    const result = runJuly([candidate], "credit");
    expect(result.lines[0].matchStatus).toBe("possible_match");
    expect(result.lines[0].matchedExpenseId).toBe("exp-employees");
    expect(result.lines[0].matchReasons.map((r) => r.code)).toContain("amount_sign_mismatch");
  });

  it("surfaces a sign-flipped charge even when description memo pollutes the joined text", () => {
    const candidate = toLedgerCandidate({
      ...baseRow,
      description: "Team dinner downtown table 4",
    });
    const result = runJuly([candidate], "credit");
    expect(result.lines[0].matchedExpenseId).toBe("exp-employees");
    expect(result.lines[0].matchStatus).toBe("possible_match");
  });

  it("surfaces a sign-flipped charge when the real merchant is only in merchant_name", () => {
    const candidate = toLedgerCandidate({
      ...baseRow,
      payee: "Chase Sapphire",
      merchant_name: "Employee's Only",
    });
    const result = runJuly([candidate], "credit");
    expect(result.lines[0].matchedExpenseId).toBe("exp-employees");
    expect(result.lines[0].matchStatus).toBe("possible_match");
  });
});
