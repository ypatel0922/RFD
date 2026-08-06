/**
 * Matching-engine scenarios.
 *
 * Each test is named for the scenario it covers so a failure points straight at
 * the behaviour that regressed.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_DATE_TOLERANCE_DAYS } from "./config";
import { matchStatementToLedger } from "./matching";
import { candidate, consolidatedLines, dollars } from "./test-fixtures";
import type { ConsolidatedLine, LedgerCandidate } from "./types";

function run(lines: ConsolidatedLine[], candidates: LedgerCandidate[]) {
  return matchStatementToLedger({
    lines,
    candidates,
    statementStartDate: "2025-03-01",
    statementEndDate: "2025-03-31",
    selectedAccountName: "Operating Checking",
    dateToleranceDays: DEFAULT_DATE_TOLERANCE_DAYS,
  });
}

describe("scenario 1 — exact amount, exact date, matching vendor", () => {
  it("auto-matches and explains why", () => {
    const lines = consolidatedLines([
      {
        postedDate: "2025-03-12",
        originalDescription: "POS DEBIT 03/12 CEDAR AUTO PARTS #221 CEDAR HOLLOW NY",
        signedAmountCents: -dollars(214.55),
      },
    ]);
    const result = run(lines, [
      candidate({
        expenseId: "exp-auto",
        date: "2025-03-12",
        signedAmountCents: -dollars(214.55),
        vendor: "Cedar Auto Parts",
      }),
    ]);

    expect(result.lines[0].matchStatus).toBe("auto_matched");
    expect(result.lines[0].matchedExpenseId).toBe("exp-auto");
    expect(result.lines[0].matchReasons.map((reason) => reason.code)).toContain("exact_amount");
    expect(result.lines[0].matchReasons.map((reason) => reason.code)).toContain("same_day");
    expect(result.counts.matched).toBe(1);
  });
});

describe("scenario 2 — exact amount with a three-day posting delay", () => {
  it("still auto-matches and records the delay in words", () => {
    const lines = consolidatedLines([
      {
        postedDate: "2025-03-15",
        originalDescription: "CHECK 1042",
        checkNumber: "1042",
        signedAmountCents: -dollars(800),
      },
    ]);
    const result = run(lines, [
      candidate({
        expenseId: "exp-delayed",
        date: "2025-03-12",
        signedAmountCents: -dollars(800),
        vendor: "Hollow Ridge Roofing",
        checkNumber: "1042",
      }),
    ]);

    expect(result.lines[0].matchStatus).toBe("auto_matched");
    const labels = result.lines[0].matchReasons.map((reason) => reason.label);
    expect(labels.some((label) => label.includes("3 days after"))).toBe(true);
  });
});

describe("scenario 3 — exact amount with a slightly different bank description", () => {
  it("matches through the bank's channel noise", () => {
    const lines = consolidatedLines([
      {
        postedDate: "2025-03-08",
        originalDescription: "ACH DEBIT RECURRING PAYMENT SUMMIT FUEL CO REF 88213",
        signedAmountCents: -dollars(1_240.18),
      },
    ]);
    const result = run(lines, [
      candidate({
        expenseId: "exp-fuel",
        date: "2025-03-08",
        signedAmountCents: -dollars(1_240.18),
        vendor: "Summit Fuel Co",
      }),
    ]);

    expect(result.lines[0].matchedExpenseId).toBe("exp-fuel");
    expect(result.lines[0].matchStatus).toBe("auto_matched");
  });
});

describe("scenario 4 — two Hallix transactions with the same amount", () => {
  it("does not auto-match on amount alone when the vendor cannot break the tie", () => {
    const lines = consolidatedLines([
      {
        postedDate: "2025-03-10",
        originalDescription: "ACH DEBIT PAYMENT 4471",
        signedAmountCents: -dollars(150),
      },
    ]);
    const result = run(lines, [
      candidate({ expenseId: "exp-a", date: "2025-03-10", signedAmountCents: -dollars(150), vendor: "Northside Supply" }),
      candidate({ expenseId: "exp-b", date: "2025-03-10", signedAmountCents: -dollars(150), vendor: "Westgate Hardware" }),
    ]);

    expect(result.lines[0].matchStatus).not.toBe("auto_matched");
    expect(result.lines[0].candidateExpenseIds.length).toBeGreaterThanOrEqual(2);
  });
});

describe("scenario 5 — two statement lines with the same vendor and amount", () => {
  it("pairs them one-to-one rather than matching both to one transaction", () => {
    const lines = consolidatedLines([
      {
        postedDate: "2025-03-04",
        rowNumber: 1,
        originalDescription: "PINE STREET DINER",
        signedAmountCents: -dollars(62.4),
      },
      {
        postedDate: "2025-03-18",
        rowNumber: 2,
        originalDescription: "PINE STREET DINER",
        signedAmountCents: -dollars(62.4),
      },
    ]);
    const result = run(lines, [
      candidate({ expenseId: "exp-first", date: "2025-03-04", signedAmountCents: -dollars(62.4), vendor: "Pine Street Diner" }),
      candidate({ expenseId: "exp-second", date: "2025-03-18", signedAmountCents: -dollars(62.4), vendor: "Pine Street Diner" }),
    ]);

    const assigned = result.lines.map((line) => line.matchedExpenseId);
    expect(new Set(assigned.filter(Boolean)).size).toBe(assigned.filter(Boolean).length);
    expect(assigned).toContain("exp-first");
    expect(assigned).toContain("exp-second");
  });

  it("never assigns one Hallix transaction to two statement lines", () => {
    const lines = consolidatedLines([
      { postedDate: "2025-03-04", rowNumber: 1, originalDescription: "PINE STREET DINER", signedAmountCents: -dollars(62.4) },
      { postedDate: "2025-03-05", rowNumber: 2, originalDescription: "PINE STREET DINER", signedAmountCents: -dollars(62.4) },
    ]);
    const result = run(lines, [
      candidate({ expenseId: "exp-only", date: "2025-03-04", signedAmountCents: -dollars(62.4), vendor: "Pine Street Diner" }),
    ]);

    const claimed = result.lines.filter((line) => line.matchedExpenseId === "exp-only");
    expect(claimed.length).toBe(1);
  });
});

describe("scenario 6 — exact check-number match", () => {
  it("matches a bare check line with no vendor text", () => {
    const lines = consolidatedLines([
      {
        postedDate: "2025-03-20",
        originalDescription: "CHECK",
        checkNumber: "2087",
        signedAmountCents: -dollars(3_500),
      },
    ]);
    const result = run(lines, [
      candidate({
        expenseId: "exp-check",
        date: "2025-03-17",
        signedAmountCents: -dollars(3_500),
        vendor: "Cedar Hollow Insurance Trust",
        checkNumber: "2087",
      }),
    ]);

    expect(result.lines[0].matchStatus).toBe("auto_matched");
    expect(result.lines[0].matchReasons.map((reason) => reason.code)).toContain("check_number_exact");
  });
});

describe("scenario 7 — deposit versus withdrawal sign handling", () => {
  it("flags a same-name opposite-sign pair for review instead of auto-matching or ignoring it", () => {
    const lines = consolidatedLines([
      {
        postedDate: "2025-03-06",
        originalDescription: "DEPOSIT FUNDRAISER PROCEEDS",
        signedAmountCents: dollars(2_400),
      },
    ]);
    const result = run(lines, [
      candidate({
        expenseId: "exp-outflow",
        date: "2025-03-06",
        signedAmountCents: -dollars(2_400),
        vendor: "Fundraiser Proceeds",
      }),
    ]);

    expect(result.lines[0].matchStatus).toBe("possible_match");
    expect(result.lines[0].matchedExpenseId).toBe("exp-outflow");
    expect(result.lines[0].matchReasons.map((reason) => reason.code)).toContain(
      "amount_sign_mismatch",
    );
  });

  it("still ignores opposite-sign pairs when the vendor does not confirm them", () => {
    const lines = consolidatedLines([
      {
        postedDate: "2025-03-06",
        originalDescription: "DEPOSIT TOWN SHARE",
        signedAmountCents: dollars(2_400),
      },
    ]);
    const result = run(lines, [
      candidate({
        expenseId: "exp-outflow",
        date: "2025-03-06",
        signedAmountCents: -dollars(2_400),
        vendor: "Shell Oil",
      }),
    ]);

    expect(result.lines[0].matchedExpenseId).toBeNull();
    expect(result.lines[0].matchStatus).toBe("unmatched");
  });

  it("matches a deposit to a recorded inflow", () => {
    const lines = consolidatedLines([
      {
        postedDate: "2025-03-06",
        originalDescription: "DEPOSIT FUNDRAISER PROCEEDS",
        signedAmountCents: dollars(2_400),
      },
    ]);
    const result = run(lines, [
      candidate({
        expenseId: "exp-inflow",
        date: "2025-03-06",
        signedAmountCents: dollars(2_400),
        vendor: "Fundraiser Proceeds",
      }),
    ]);

    expect(result.lines[0].matchedExpenseId).toBe("exp-inflow");
  });
});

describe("scenario 8 — bank fee missing from Hallix", () => {
  it("reports the fee as a statement-only line", () => {
    const lines = consolidatedLines([
      {
        postedDate: "2025-03-31",
        originalDescription: "MONTHLY SERVICE FEE",
        signedAmountCents: -dollars(12),
      },
    ]);
    const result = run(lines, []);

    expect(result.lines[0].matchStatus).toBe("unmatched");
    expect(result.counts.statementOnly).toBe(1);
  });
});

describe("scenario 9 — Hallix check still outstanding and absent from the statement", () => {
  it("lists it as ledger-only and does not reconcile it", () => {
    const result = run(consolidatedLines([]), [
      candidate({
        expenseId: "exp-outstanding",
        date: "2025-03-28",
        signedAmountCents: -dollars(945.12),
        vendor: "Ridgeline Equipment",
        checkNumber: "2101",
      }),
    ]);

    expect(result.ledgerOnlyExpenseIds).toEqual(["exp-outstanding"]);
    expect(result.counts.ledgerOnly).toBe(1);
    expect(result.counts.matched).toBe(0);
  });
});

describe("scenario 20 — attempt to match a transaction already reconciled", () => {
  it("flags it instead of reconciling it twice", () => {
    const lines = consolidatedLines([
      {
        postedDate: "2025-03-14",
        originalDescription: "LAKESIDE TIRE AND AUTO",
        signedAmountCents: -dollars(410),
      },
    ]);
    const result = run(lines, [
      candidate({
        expenseId: "exp-done",
        date: "2025-03-14",
        signedAmountCents: -dollars(410),
        vendor: "Lakeside Tire and Auto",
        isAlreadyReconciled: true,
      }),
    ]);

    expect(result.lines[0].matchStatus).toBe("already_reconciled");
    expect(result.lines[0].matchedExpenseId).toBeNull();
    expect(result.ledgerOnlyExpenseIds).not.toContain("exp-done");
  });
});

describe("scenario 25 — a statement containing both expenses and deposits", () => {
  it("matches each side in the right direction and counts them separately", () => {
    const lines = consolidatedLines([
      { rowNumber: 1, postedDate: "2025-03-03", originalDescription: "DEPOSIT TOWN OF CEDAR HOLLOW", signedAmountCents: dollars(15_000) },
      { rowNumber: 2, postedDate: "2025-03-09", originalDescription: "ACH DEBIT VALLEY POWER AND LIGHT", signedAmountCents: -dollars(486.22) },
      { rowNumber: 3, postedDate: "2025-03-21", originalDescription: "INTEREST PAID", signedAmountCents: dollars(1.84) },
      { rowNumber: 4, postedDate: "2025-03-27", originalDescription: "CHECK 2110", checkNumber: "2110", signedAmountCents: -dollars(1_200) },
    ]);
    const result = run(lines, [
      candidate({ expenseId: "exp-town", date: "2025-03-03", signedAmountCents: dollars(15_000), vendor: "Town of Cedar Hollow" }),
      candidate({ expenseId: "exp-power", date: "2025-03-09", signedAmountCents: -dollars(486.22), vendor: "Valley Power and Light" }),
      candidate({ expenseId: "exp-check", date: "2025-03-25", signedAmountCents: -dollars(1_200), vendor: "Cedar Hollow Auto Body", checkNumber: "2110" }),
    ]);

    expect(result.counts.matched).toBe(3);
    // Interest was never recorded in Hallix, so it stays a statement-only line.
    expect(result.lines[2].matchStatus).toBe("unmatched");
    expect(result.counts.statementOnly).toBe(1);
  });
});

describe("vendor-name tolerance — the bank's wording of a merchant", () => {
  it("matches a receipt vendor wrapped in a processor prefix, legal suffix and city", () => {
    const lines = consolidatedLines([
      {
        postedDate: "2025-03-14",
        originalDescription: "SQ *EMPLOYEES ONLY LLC NEW YORK NY",
        signedAmountCents: -dollars(47.5),
      },
    ]);
    const result = run(lines, [
      candidate({
        expenseId: "exp-restaurant",
        date: "2025-03-14",
        signedAmountCents: -dollars(47.5),
        vendor: "Employees Only",
      }),
    ]);

    expect(result.lines[0].matchStatus).toBe("auto_matched");
    expect(result.lines[0].matchedExpenseId).toBe("exp-restaurant");
    expect(result.lines[0].matchReasons.map((reason) => reason.code)).toContain("vendor_strong");
  });

  it("matches a possessive Hallix name to the bank's plural form", () => {
    const lines = consolidatedLines([
      {
        postedDate: "2025-03-14",
        originalDescription: "SQ *EMPLOYEES ONLY LLC NEW YORK NY",
        signedAmountCents: -dollars(47.5),
      },
    ]);
    const result = run(lines, [
      candidate({
        expenseId: "exp-apostrophe",
        date: "2025-03-14",
        signedAmountCents: -dollars(47.5),
        vendor: "Employee's Only",
      }),
    ]);

    expect(result.lines[0].matchStatus).toBe("auto_matched");
    expect(result.lines[0].matchedExpenseId).toBe("exp-apostrophe");
  });

  it("matches Capo Restaurant to a Toast descriptor that drops the word Restaurant", () => {
    const lines = consolidatedLines([
      {
        postedDate: "2025-03-05",
        originalDescription: "TST* CAPO SOUTH BOSTON SOUTH BOSTON MA",
        signedAmountCents: -dollars(100),
      },
    ]);
    const result = run(lines, [
      candidate({
        expenseId: "exp-capo",
        date: "2025-03-04",
        signedAmountCents: -dollars(90.95),
        vendor: "Capo Restaurant",
      }),
    ]);

    expect(result.lines[0].matchStatus).toBe("possible_match");
    expect(result.lines[0].matchedExpenseId).toBe("exp-capo");
    expect(result.lines[0].matchReasons.map((reason) => reason.code)).toContain("amount_tip");
    expect(result.lines[0].matchReasons.map((reason) => reason.code)).toContain("vendor_strong");
    expect(result.ledgerOnlyExpenseIds).toEqual([]);
  });

  it("still refuses two different vendors that share a word", () => {
    const lines = consolidatedLines([
      {
        postedDate: "2025-03-14",
        originalDescription: "ACH DEBIT NATIONAL FUEL LLC",
        signedAmountCents: -dollars(310),
      },
    ]);
    const result = run(lines, [
      candidate({
        expenseId: "exp-grid",
        date: "2025-03-14",
        signedAmountCents: -dollars(288),
        vendor: "National Grid",
      }),
    ]);

    expect(result.lines[0].matchedExpenseId).toBeNull();
  });
});

describe("gratuity tolerance — a tip written on after the receipt printed", () => {
  const tippedLine = (description = "SQ *EMPLOYEES ONLY LLC NEW YORK NY", charged = 57.5) =>
    consolidatedLines([
      { postedDate: "2025-03-14", originalDescription: description, signedAmountCents: -dollars(charged) },
    ]);

  const restaurant = (overrides = {}) =>
    candidate({
      expenseId: "exp-restaurant",
      date: "2025-03-14",
      signedAmountCents: -dollars(47.5),
      vendor: "Employees Only",
      ...overrides,
    });

  it("proposes the pairing for review and explains the tip in plain words", () => {
    const result = run(tippedLine(), [restaurant()]);

    expect(result.lines[0].matchStatus).toBe("possible_match");
    expect(result.lines[0].matchedExpenseId).toBe("exp-restaurant");
    expect(result.lines[0].matchReasons.map((reason) => reason.code)).toContain("amount_tip");
    const labels = result.lines[0].matchReasons.map((reason) => reason.label).join(" ");
    expect(labels).toContain("$10.00 more");
    expect(result.counts.needsReview).toBe(1);
  });

  it("never applies a tipped pairing automatically, because the amounts do differ", () => {
    const result = run(tippedLine(), [restaurant()]);
    expect(result.lines[0].matchStatus).not.toBe("auto_matched");
    expect(result.counts.matched).toBe(0);
  });

  it("stops the transaction being reported as missing from the statement", () => {
    const result = run(tippedLine(), [restaurant()]);
    expect(result.ledgerOnlyExpenseIds).toEqual([]);
    expect(result.counts.ledgerOnly).toBe(0);
  });

  it("rejects an overage too large to be a tip", () => {
    const result = run(tippedLine("SQ *EMPLOYEES ONLY LLC NEW YORK NY", 80), [restaurant()]);

    expect(result.lines[0].matchedExpenseId).toBeNull();
    expect(result.lines[0].matchStatus).toBe("unmatched");
    expect(result.counts.ledgerOnly).toBe(1);
  });

  it("rejects a tip-sized gap on a large bill, where the dollars are no longer a tip", () => {
    const lines = consolidatedLines([
      { postedDate: "2025-03-14", originalDescription: "HARBOR CATERING", signedAmountCents: -dollars(1_200) },
    ]);
    const result = run(lines, [
      candidate({
        expenseId: "exp-catering",
        date: "2025-03-14",
        signedAmountCents: -dollars(1_000),
        vendor: "Harbor Catering",
      }),
    ]);

    expect(result.lines[0].matchedExpenseId).toBeNull();
  });

  it("does not forgive the amount when the vendor is a different one", () => {
    const result = run(tippedLine("SHELL OIL 2231 RIVERHEAD NY"), [restaurant()]);
    expect(result.lines[0].matchedExpenseId).toBeNull();
  });

  it("does not forgive the amount when the dates are outside the window", () => {
    const result = run(tippedLine(), [restaurant({ date: "2025-03-01" })]);
    expect(result.lines[0].matchedExpenseId).toBeNull();
  });

  it("does not apply to deposits, where there is no tip to add", () => {
    const lines = consolidatedLines([
      {
        postedDate: "2025-03-14",
        originalDescription: "DEPOSIT HOLLOW RIDGE FUNDRAISER",
        signedAmountCents: dollars(57.5),
      },
    ]);
    const result = run(lines, [
      candidate({
        expenseId: "exp-inflow",
        date: "2025-03-14",
        signedAmountCents: dollars(47.5),
        vendor: "Hollow Ridge Fundraiser",
      }),
    ]);

    expect(result.lines[0].matchedExpenseId).toBeNull();
  });

  it("prefers an exact-amount transaction over a tipped one for the same vendor", () => {
    const lines = consolidatedLines([
      {
        postedDate: "2025-03-14",
        originalDescription: "SQ *EMPLOYEES ONLY LLC NEW YORK NY",
        signedAmountCents: -dollars(57.5),
      },
    ]);
    const result = run(lines, [
      restaurant({ expenseId: "exp-tipped" }),
      restaurant({ expenseId: "exp-exact", signedAmountCents: -dollars(57.5) }),
    ]);

    expect(result.lines[0].matchedExpenseId).toBe("exp-exact");
  });
});

describe("determinism", () => {
  it("produces identical results across runs with shuffled candidate order", () => {
    const lines = consolidatedLines([
      { rowNumber: 1, postedDate: "2025-03-11", originalDescription: "NORTH FORK PRINTING", signedAmountCents: -dollars(320) },
      { rowNumber: 2, postedDate: "2025-03-11", originalDescription: "NORTH FORK PRINTING", signedAmountCents: -dollars(320) },
    ]);
    const candidates = [
      candidate({ expenseId: "exp-b", date: "2025-03-11", signedAmountCents: -dollars(320), vendor: "North Fork Printing" }),
      candidate({ expenseId: "exp-a", date: "2025-03-11", signedAmountCents: -dollars(320), vendor: "North Fork Printing" }),
    ];

    const first = run(lines, candidates);
    const second = run(lines, [...candidates].reverse());

    expect(first.lines.map((line) => [line.fingerprint, line.matchedExpenseId])).toEqual(
      second.lines.map((line) => [line.fingerprint, line.matchedExpenseId]),
    );
  });
});

describe("manual decisions", () => {
  it("keeps a treasurer's manual match and withholds that transaction from the auto pass", () => {
    const lines = consolidatedLines([
      { rowNumber: 1, postedDate: "2025-03-02", originalDescription: "WESTGATE HARDWARE", signedAmountCents: -dollars(75) },
      { rowNumber: 2, postedDate: "2025-03-02", originalDescription: "WESTGATE HARDWARE", signedAmountCents: -dollars(75) },
    ]);

    const result = matchStatementToLedger({
      lines,
      candidates: [
        candidate({ expenseId: "exp-picked", date: "2025-03-02", signedAmountCents: -dollars(75), vendor: "Westgate Hardware" }),
      ],
      statementStartDate: "2025-03-01",
      statementEndDate: "2025-03-31",
      selectedAccountName: "Operating Checking",
      dateToleranceDays: DEFAULT_DATE_TOLERANCE_DAYS,
      lockedLines: {
        [lines[0].fingerprint]: {
          matchStatus: "manually_matched",
          matchedExpenseId: "exp-picked",
          matchScore: null,
          matchReasons: [],
        },
      },
    });

    expect(result.lines[0].matchStatus).toBe("manually_matched");
    expect(result.lines[1].matchedExpenseId).toBeNull();
  });
});
