/**
 * Balance-validation scenarios: wrong balances, running-balance breaks, reversed
 * columns, unreadable amounts, missing pages, and period overlap.
 */

import { describe, expect, it } from "vitest";

import { consolidatedLines, dollars, statement } from "./test-fixtures";
import { validateStatement } from "./validate";
import type { ValidationFinding, ValidationFindingCode } from "./types";

function codes(findings: ValidationFinding[]): ValidationFindingCode[] {
  return findings.map((finding) => finding.code);
}

/** March fixture: 1,000.00 in, 400.00 out, so 5,000.00 -> 5,600.00. */
const MARCH_LINES = consolidatedLines([
  { rowNumber: 1, postedDate: "2025-03-03", originalDescription: "DEPOSIT TOWN SHARE", signedAmountCents: dollars(1_000) },
  { rowNumber: 2, postedDate: "2025-03-11", originalDescription: "SUMMIT FUEL CO", signedAmountCents: -dollars(250) },
  { rowNumber: 3, postedDate: "2025-03-19", originalDescription: "WESTGATE HARDWARE", signedAmountCents: -dollars(150) },
]);

function validate(overrides: Parameters<typeof statement>[0] = {}, extra: Partial<Parameters<typeof validateStatement>[0]> = {}) {
  return validateStatement({
    statement: statement({
      lines: MARCH_LINES,
      beginningBalanceCents: dollars(5_000),
      endingBalanceCents: dollars(5_600),
      ...overrides,
    }),
    selectedAccountLastFour: "4417",
    previousReconciliations: [],
    ...extra,
  });
}

describe("a statement that adds up", () => {
  it("balances and can be confirmed without an override", () => {
    const result = validate();
    expect(result.status).toBe("balanced");
    expect(result.totalCreditsCents).toBe(dollars(1_000));
    expect(result.totalDebitsCents).toBe(dollars(400));
    expect(result.canConfirmWithoutOverride).toBe(true);
  });

  it("tolerates a one-cent rounding difference but not two", () => {
    expect(validate({ endingBalanceCents: dollars(5_600) + 1 }).status).toBe("balanced");
    expect(validate({ endingBalanceCents: dollars(5_600) + 2 }).status).toBe("out_of_balance");
  });
});

describe("scenario 13 — incorrect beginning balance", () => {
  it("reports the exact shortfall rather than a bare failure", () => {
    const result = validate({ beginningBalanceCents: dollars(4_900) });
    expect(result.status).toBe("out_of_balance");
    expect(result.balanceDifferenceCents).toBe(dollars(100));
    expect(codes(result.findings)).toContain("out_of_balance");
    expect(result.findings.find((finding) => finding.code === "out_of_balance")?.message).toContain("$100.00");
  });

  it("is treated as incomplete, not wrong, when the balance is missing entirely", () => {
    const result = validate({ beginningBalanceCents: null });
    expect(result.status).toBe("incomplete");
    expect(codes(result.findings)).toContain("beginning_balance_missing");
  });

  it("accepts a balance the treasurer typed in", () => {
    const result = validate({ beginningBalanceCents: null }, { manualBeginningBalanceCents: dollars(5_000) });
    expect(result.status).toBe("balanced");
  });
});

describe("scenario 14 — incorrect ending balance", () => {
  it("names the difference and both sides of the arithmetic", () => {
    const result = validate({ endingBalanceCents: dollars(5_575) });
    expect(result.status).toBe("out_of_balance");
    expect(result.balanceDifferenceCents).toBe(-dollars(25));
    expect(result.findings.find((finding) => finding.code === "out_of_balance")?.message).toContain("$5,600.00");
  });

  it("is incomplete when the ending balance could not be read", () => {
    const result = validate({ endingBalanceCents: null });
    expect(result.status).toBe("incomplete");
    expect(codes(result.findings)).toContain("ending_balance_missing");
  });
});

describe("scenario 15 — running-balance discontinuity", () => {
  it("points at the row where the running balance stops adding up", () => {
    const lines = consolidatedLines([
      { rowNumber: 1, postedDate: "2025-03-03", originalDescription: "DEPOSIT TOWN SHARE", signedAmountCents: dollars(1_000), runningBalanceCents: dollars(6_000) },
      // 6,000 - 250 should be 5,750; the statement shows 5,700, so a row is missing.
      { rowNumber: 2, postedDate: "2025-03-11", originalDescription: "SUMMIT FUEL CO", signedAmountCents: -dollars(250), runningBalanceCents: dollars(5_700) },
    ]);

    const result = validateStatement({
      statement: statement({ lines, beginningBalanceCents: dollars(5_000), endingBalanceCents: dollars(5_700) }),
      selectedAccountLastFour: "4417",
      previousReconciliations: [],
    });

    expect(codes(result.findings)).toContain("running_balance_discontinuity");
    const finding = result.findings.find((entry) => entry.code === "running_balance_discontinuity");
    expect(finding?.detail?.row_number).toBe(2);
  });
});

describe("scenario 18 — debit and credit columns reversed", () => {
  it("says the statement balances with the columns swapped", () => {
    const swapped = consolidatedLines([
      { rowNumber: 1, postedDate: "2025-03-03", originalDescription: "DEPOSIT TOWN SHARE", signedAmountCents: -dollars(1_000) },
      { rowNumber: 2, postedDate: "2025-03-11", originalDescription: "SUMMIT FUEL CO", signedAmountCents: dollars(250) },
      { rowNumber: 3, postedDate: "2025-03-19", originalDescription: "WESTGATE HARDWARE", signedAmountCents: dollars(150) },
    ]);

    const result = validateStatement({
      statement: statement({ lines: swapped, beginningBalanceCents: dollars(5_000), endingBalanceCents: dollars(5_600) }),
      selectedAccountLastFour: "4417",
      previousReconciliations: [],
    });

    expect(result.status).toBe("out_of_balance");
    expect(codes(result.findings)).toContain("columns_possibly_reversed");
  });

  it("does not blame the columns for an ordinary out-of-balance", () => {
    const result = validate({ endingBalanceCents: dollars(5_432.1) });
    expect(codes(result.findings)).not.toContain("columns_possibly_reversed");
  });
});

describe("scenario 19 — low-confidence or unreadable amount", () => {
  it("blocks confirmation and names the page to retake", () => {
    const lines = consolidatedLines([
      { rowNumber: 1, postedDate: "2025-03-03", originalDescription: "DEPOSIT TOWN SHARE", signedAmountCents: dollars(1_000) },
      {
        rowNumber: 2,
        pageNumber: 2,
        postedDate: "2025-03-11",
        originalDescription: "SUMMIT FUEL CO",
        signedAmountCents: null,
        extractionConfidence: 0.3,
        extractionWarning: "The amount column was cut off in the photo.",
      },
    ]);

    const result = validateStatement({
      statement: statement({ lines, beginningBalanceCents: dollars(5_000), endingBalanceCents: dollars(5_600) }),
      selectedAccountLastFour: "4417",
      previousReconciliations: [],
    });

    expect(codes(result.findings)).toContain("amount_unreadable");
    expect(result.canConfirmWithoutOverride).toBe(false);
    expect(result.findings.find((entry) => entry.code === "amount_unreadable")?.message).toContain("page 2");
  });
});

describe("scenario 12 — missing statement page reaches validation as blocking", () => {
  it("refuses to call the statement balanced when a page was never added", () => {
    const result = validate({ missingPrintedPages: [2], printedPageCount: 3 });
    expect(codes(result.findings)).toContain("pages_possibly_missing");
    expect(result.status).toBe("incomplete");
    expect(result.canConfirmWithoutOverride).toBe(false);
  });
});

describe("account identity and period overlap", () => {
  it("flags a statement for a different account", () => {
    const result = validate({ accountLastFour: "9902" });
    expect(codes(result.findings)).toContain("account_last_four_mismatch");
    expect(result.canConfirmWithoutOverride).toBe(false);
  });

  it("warns when the period overlaps a completed reconciliation but still allows it", () => {
    const result = validate(
      {},
      {
        previousReconciliations: [
          { sessionId: "prev", statementStartDate: "2025-02-16", statementEndDate: "2025-03-15" },
        ],
      },
    );
    expect(codes(result.findings)).toContain("period_overlaps_previous_reconciliation");
    expect(result.status).toBe("balanced");
  });

  it("does not warn about an adjacent, non-overlapping period", () => {
    const result = validate(
      {},
      {
        previousReconciliations: [
          { sessionId: "prev", statementStartDate: "2025-02-01", statementEndDate: "2025-02-28" },
        ],
      },
    );
    expect(codes(result.findings)).not.toContain("period_overlaps_previous_reconciliation");
  });
});

describe("pending transactions", () => {
  it("excludes pending rows from the statement totals", () => {
    const lines = consolidatedLines([
      { rowNumber: 1, postedDate: "2025-03-03", originalDescription: "DEPOSIT TOWN SHARE", signedAmountCents: dollars(1_000) },
      { rowNumber: 2, postedDate: "2025-03-11", originalDescription: "SUMMIT FUEL CO", signedAmountCents: -dollars(250) },
      { rowNumber: 3, postedDate: "2025-03-19", originalDescription: "WESTGATE HARDWARE", signedAmountCents: -dollars(150) },
      { rowNumber: 4, postedDate: "2025-03-31", originalDescription: "PENDING CARD HOLD", signedAmountCents: -dollars(75), isPending: true },
    ]);

    const result = validateStatement({
      statement: statement({ lines, beginningBalanceCents: dollars(5_000), endingBalanceCents: dollars(5_600) }),
      selectedAccountLastFour: "4417",
      previousReconciliations: [],
    });

    expect(result.status).toBe("balanced");
    expect(result.totalDebitsCents).toBe(dollars(400));
  });
});
