/**
 * Bank description normalization.
 *
 * These are the real shapes banks print. Normalization has to strip enough noise
 * that "POS DEBIT 04/12 TRACTOR SUPPLY #1482 RIVERHEAD NY" matches a ledger
 * vendor of "Tractor Supply", without stripping so much that two different
 * vendors collapse into the same string.
 */

import { describe, expect, it } from "vitest";

import {
  containsVendorName,
  descriptionSimilarity,
  extractCheckNumber,
  looksLikeNonTransactionRow,
  looksLikeWrappedContinuation,
  normalizeCheckNumber,
  normalizeDescription,
  normalizeReferenceNumber,
} from "./description";

describe("normalizing a printed bank description", () => {
  it("strips channel words, dates, store numbers and location noise", () => {
    expect(normalizeDescription("POS DEBIT 04/12 TRACTOR SUPPLY #1482 RIVERHEAD NY")).toBe(
      "tractor supply riverhead",
    );
    expect(normalizeDescription("ACH WEB PMT VERIZON WIRELESS")).toBe("verizon wireless");
    expect(normalizeDescription("CHECK 2087")).toBe("");
    expect(normalizeDescription("PREAUTHORIZED WD NATIONAL GRID")).toBe("national grid");
  });

  it("unwraps payment-processor prefixes to expose the merchant", () => {
    expect(normalizeDescription("SQ *RIVERHEAD DINER")).toBe("riverhead diner");
    expect(normalizeDescription("TST* HOSE & LADDER CAFE")).toBe("hose ladder cafe");
  });

  it("removes masked card digits in the shapes banks use", () => {
    expect(normalizeDescription("CARD PURCHASE XXXX4471 HOME DEPOT")).toBe("home depot");
    expect(normalizeDescription("DEBIT CARD 4471****1234 LOWES")).toBe("lowes");
  });

  it("keeps different vendors distinguishable", () => {
    expect(normalizeDescription("ACH DEBIT NATIONAL GRID")).not.toBe(
      normalizeDescription("ACH DEBIT NATIONAL FUEL"),
    );
  });

  it("returns empty rather than a misleading string when only noise is present", () => {
    expect(normalizeDescription("ACH DEBIT 04/12 REF 889321")).toBe("");
    expect(normalizeDescription(null)).toBe("");
  });

  it("does not erase a description that is only a state code", () => {
    expect(normalizeDescription("NY")).toBe("ny");
  });

  it("drops the legal-entity wording a bank adds to a trading name", () => {
    expect(normalizeDescription("SQ *EMPLOYEES ONLY LLC NEW YORK NY")).toBe(
      "employees only new york",
    );
    expect(normalizeDescription("RIDGELINE EQUIPMENT INC")).toBe("ridgeline equipment");
    expect(normalizeDescription("THE HOSE AND LADDER COMPANY")).toBe("hose and ladder");
  });

  it("keeps the entity wording when it is the whole name", () => {
    expect(normalizeDescription("The Company")).toBe("the company");
  });
});

describe("finding a recorded vendor inside a bank description", () => {
  it("recognizes the name inside the card processor's extra wording", () => {
    expect(
      containsVendorName(
        normalizeDescription("SQ *EMPLOYEES ONLY LLC NEW YORK NY"),
        normalizeDescription("Employees Only"),
      ),
    ).toBe(true);
  });

  it("folds possessives and soft plurals so Employee's matches employees", () => {
    expect(normalizeDescription("Employee's Only")).toBe("employees only");
    expect(
      containsVendorName(
        normalizeDescription("SQ *EMPLOYEES ONLY LLC NEW YORK NY"),
        normalizeDescription("Employee's Only"),
      ),
    ).toBe(true);
  });

  it("ignores a generic business word the treasurer typed that the bank omitted", () => {
    expect(
      containsVendorName(
        normalizeDescription("TST* CAPO SOUTH BOSTON SOUTH BOSTON MA"),
        normalizeDescription("Capo Restaurant"),
      ),
    ).toBe(true);
  });

  it("does not claim a match when a distinctive word of the vendor name is absent", () => {
    expect(
      containsVendorName(
        normalizeDescription("ACH DEBIT NATIONAL FUEL"),
        normalizeDescription("National Grid"),
      ),
    ).toBe(false);
  });

  it("needs a real word, so a two-letter fragment cannot match everything", () => {
    expect(containsVendorName("employees only new york", "ny")).toBe(false);
    expect(containsVendorName("", "employees only")).toBe(false);
  });
});

describe("similarity between a bank description and a ledger vendor", () => {
  it("scores a contained vendor name highly", () => {
    const bank = normalizeDescription("POS DEBIT 04/12 TRACTOR SUPPLY #1482 RIVERHEAD NY");
    expect(descriptionSimilarity(bank, normalizeDescription("Tractor Supply"))).toBeGreaterThan(0.6);
  });

  it("tolerates a small spelling or OCR difference", () => {
    const bank = normalizeDescription("ACH PMT FIREHOUSE SUPPLY CO");
    expect(descriptionSimilarity(bank, normalizeDescription("Firehouse Supply"))).toBeGreaterThan(
      0.6,
    );
  });

  it("scores unrelated vendors low", () => {
    const bank = normalizeDescription("ACH DEBIT NATIONAL GRID");
    expect(descriptionSimilarity(bank, normalizeDescription("Riverhead Diner"))).toBeLessThan(0.3);
  });

  it("treats a missing description as no signal rather than a match", () => {
    expect(descriptionSimilarity("", "")).toBe(0);
    expect(descriptionSimilarity("tractor supply", "")).toBe(0);
  });

  it("is symmetric, so candidate order cannot change a score", () => {
    const a = normalizeDescription("POS DEBIT HOME DEPOT #6152");
    const b = normalizeDescription("Home Depot");
    expect(descriptionSimilarity(a, b)).toBeCloseTo(descriptionSimilarity(b, a));
  });
});

describe("check and reference numbers", () => {
  it("finds a check number written into the description", () => {
    expect(extractCheckNumber("CHECK 2087")).toBe("2087");
    expect(extractCheckNumber("CK#0042")).toBe("42");
    expect(extractCheckNumber("Check No. 1042 CLEARED")).toBe("1042");
    expect(extractCheckNumber("#1042")).toBe("1042");
  });

  it("does not read a store number as a check number", () => {
    expect(extractCheckNumber("TRACTOR SUPPLY #1482 RIVERHEAD NY")).toBeNull();
  });

  it("compares check numbers without leading zeros", () => {
    expect(normalizeCheckNumber("0042")).toBe(normalizeCheckNumber("42"));
    expect(normalizeCheckNumber("Check 1042")).toBe("1042");
    expect(normalizeCheckNumber("")).toBeNull();
  });

  it("compares reference numbers ignoring case and separators", () => {
    expect(normalizeReferenceNumber("REF# ABC-1234")).toBe(normalizeReferenceNumber("ref abc1234"));
    // Too short to identify anything.
    expect(normalizeReferenceNumber("A1")).toBeNull();
  });
});

describe("scenario 17 — structural rows that are not transactions", () => {
  it("recognizes headers, subtotals and continuation markers", () => {
    for (const row of [
      "Balance Forward",
      "BEGINNING BALANCE",
      "Ending Balance",
      "Total Deposits and Other Credits",
      "Subtotal",
      "Continued on next page",
      "Date Description Amount",
      "Daily Ending Balance",
      "Page 2 of 4",
      "Account Summary",
      "Statement Period",
      "Member FDIC",
      "Checks Paid",
      "Withdrawals and Other Debits",
      "Year-to-Date Interest",
    ]) {
      expect(looksLikeNonTransactionRow(row), row).toBe(true);
    }
  });

  it("leaves real transactions alone, including short deposit/withdrawal labels", () => {
    for (const row of [
      "TRACTOR SUPPLY #1482",
      "CHECK 2087",
      "ACH PMT NATIONAL GRID",
      "TOTAL WINE & MORE RIVERHEAD",
      "BALANCED BODY MASSAGE LLC",
      "DEPOSIT TOWN SHARE",
      "Deposit",
      "Electronic Withdrawal",
      "Electronic Deposit",
      "Withdrawal",
    ]) {
      expect(looksLikeNonTransactionRow(row), row).toBe(false);
    }
  });
});

describe("scenario 16 — a description that wrapped onto a second line", () => {
  const base = {
    postedDate: null,
    transactionDate: null,
    signedAmountCents: null,
    runningBalanceCents: null,
    originalDescription: null as string | null,
  };

  it("treats a short amountless dateless row as a continuation", () => {
    expect(
      looksLikeWrappedContinuation({ ...base, originalDescription: "INDN: CEDAR HOLLOW FD" }),
    ).toBe(true);
  });

  it("does not treat a row with its own amount as a continuation", () => {
    expect(
      looksLikeWrappedContinuation({
        ...base,
        originalDescription: "INDN: CEDAR HOLLOW FD",
        signedAmountCents: -4_500,
      }),
    ).toBe(false);
  });

  it("does not treat a row with its own date or running balance as a continuation", () => {
    expect(
      looksLikeWrappedContinuation({
        ...base,
        originalDescription: "SOMETHING",
        postedDate: "2025-03-14",
      }),
    ).toBe(false);
    expect(
      looksLikeWrappedContinuation({
        ...base,
        originalDescription: "SOMETHING",
        runningBalanceCents: 100_000,
      }),
    ).toBe(false);
  });
});
