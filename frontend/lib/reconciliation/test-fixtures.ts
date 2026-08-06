/**
 * Synthetic statement and ledger fixtures for the reconciliation tests.
 *
 * Everything here is invented. There are no real account numbers, routing
 * numbers, vendors or amounts, and nothing is copied from an actual statement.
 * The department is a fictional "Cedar Hollow Fire District".
 */

import { normalizeDescription } from "./description";
import { assignFingerprints } from "./fingerprint";
import type { PageForConsolidation } from "./consolidate";
import type {
  ConsolidatedLine,
  ConsolidatedStatement,
  ExtractedPageHeader,
  ExtractedPageLine,
  LedgerCandidate,
} from "./types";

export const ACCOUNT_KEY = "acct-cedar-hollow-operating";

export function pageLine(overrides: Partial<ExtractedPageLine> = {}): ExtractedPageLine {
  const description = overrides.originalDescription ?? "GENERIC VENDOR";
  return {
    postedDate: "2025-03-05",
    transactionDate: null,
    originalDescription: description,
    normalizedDescription: overrides.normalizedDescription ?? normalizeDescription(description),
    debitAmountCents: null,
    creditAmountCents: null,
    signedAmountCents: -1000,
    checkNumber: null,
    referenceNumber: null,
    runningBalanceCents: null,
    pageNumber: 1,
    rowNumber: 1,
    sectionHeading: null,
    isPending: false,
    isContinuation: false,
    extractionConfidence: 0.98,
    extractionWarning: null,
    ...overrides,
  };
}

export function pageHeader(overrides: Partial<ExtractedPageHeader> = {}): ExtractedPageHeader {
  return {
    financialInstitution: "Cedar Hollow Community Bank",
    accountType: "Business Checking",
    accountHolder: "Cedar Hollow Fire District",
    accountLastFour: "4417",
    statementStartDate: "2025-03-01",
    statementEndDate: "2025-03-31",
    beginningBalanceCents: null,
    endingBalanceCents: null,
    totalCreditsCents: null,
    totalDebitsCents: null,
    printedPageNumber: 1,
    printedPageCount: 1,
    sectionHeadings: [],
    ...overrides,
  };
}

export function page(overrides: Partial<PageForConsolidation> = {}): PageForConsolidation {
  return {
    clientPageId: overrides.clientPageId ?? "page-1",
    pageOrder: 1,
    imageDigest: overrides.imageDigest ?? "digest-1",
    header: overrides.header ?? pageHeader(),
    lines: overrides.lines ?? [],
    ...overrides,
  };
}

export function candidate(overrides: Partial<LedgerCandidate> = {}): LedgerCandidate {
  const description = overrides.description ?? null;
  const vendor = overrides.vendor ?? "Generic Vendor";
  const matchNames =
    overrides.matchNames ??
    [normalizeDescription(vendor), normalizeDescription(description)].filter(
      (value, index, all): value is string => Boolean(value) && all.indexOf(value) === index,
    );
  return {
    expenseId: "exp-1",
    date: "2025-03-05",
    signedAmountCents: -1000,
    checkNumber: null,
    referenceNumber: null,
    bankAccountName: "Operating Checking",
    category: "Apparatus",
    isAlreadyReconciled: false,
    ...overrides,
    vendor: overrides.vendor ?? vendor,
    description: overrides.description ?? description,
    matchNames: overrides.matchNames ?? matchNames,
    normalizedText: overrides.normalizedText ?? (overrides.matchNames ?? matchNames).join(" "),
  };
}

/** Build consolidated lines directly, bypassing pass 2, for matching tests. */
export function consolidatedLines(lines: Array<Partial<ExtractedPageLine>>): ConsolidatedLine[] {
  return assignFingerprints(
    ACCOUNT_KEY,
    lines.map((overrides, index) => pageLine({ rowNumber: index + 1, ...overrides })),
  );
}

export function statement(
  overrides: Partial<ConsolidatedStatement> = {},
): ConsolidatedStatement {
  return {
    financialInstitution: "Cedar Hollow Community Bank",
    accountType: "Business Checking",
    accountHolder: "Cedar Hollow Fire District",
    accountLastFour: "4417",
    statementStartDate: "2025-03-01",
    statementEndDate: "2025-03-31",
    beginningBalanceCents: 1_000_00,
    endingBalanceCents: 1_000_00,
    reportedTotalCreditsCents: null,
    reportedTotalDebitsCents: null,
    printedPageCount: 1,
    observedPageCount: 1,
    missingPrintedPages: [],
    duplicatePageGroups: [],
    lines: [],
    removedRowCount: 0,
    warnings: [],
    ...overrides,
  };
}

/** Convenience: dollars to integer cents, for readable fixtures. */
export function dollars(amount: number): number {
  return Math.round(amount * 100);
}
