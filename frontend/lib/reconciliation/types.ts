import type { Cents } from "./money";
import type { IsoDate } from "./dates";

/**
 * Sign convention used everywhere in this feature:
 *
 *   signedAmountCents > 0  money INTO the account (deposit / credit)
 *   signedAmountCents < 0  money OUT of the account (withdrawal / debit)
 *
 * This is the bank's own convention. Hallix stores `expenses.total_amount` with
 * the opposite sense (positive = money spent), so `lib/reconciliation/ledger.ts`
 * is the single place that converts between the two.
 */

/** One transaction row as printed on a single statement page (pass 1 output). */
export type ExtractedPageLine = {
  postedDate: IsoDate | null;
  transactionDate: IsoDate | null;
  originalDescription: string;
  normalizedDescription: string;
  debitAmountCents: Cents | null;
  creditAmountCents: Cents | null;
  signedAmountCents: Cents | null;
  checkNumber: string | null;
  referenceNumber: string | null;
  runningBalanceCents: Cents | null;
  pageNumber: number;
  rowNumber: number;
  sectionHeading: string | null;
  isPending: boolean;
  /** The model flagged this row as the tail of a description that wrapped. */
  isContinuation: boolean;
  extractionConfidence: number;
  extractionWarning: string | null;
};

/** Header/summary fields read from a single page (pass 1 output). */
export type ExtractedPageHeader = {
  financialInstitution: string | null;
  accountType: string | null;
  accountHolder: string | null;
  accountLastFour: string | null;
  statementStartDate: IsoDate | null;
  statementEndDate: IsoDate | null;
  beginningBalanceCents: Cents | null;
  endingBalanceCents: Cents | null;
  totalCreditsCents: Cents | null;
  totalDebitsCents: Cents | null;
  printedPageNumber: number | null;
  printedPageCount: number | null;
  sectionHeadings: string[];
};

export type PageExtractionResult = {
  header: ExtractedPageHeader;
  lines: ExtractedPageLine[];
  warnings: string[];
  model: string;
};

/** A consolidated statement line after pass 2. */
export type ConsolidatedLine = ExtractedPageLine & {
  fingerprint: string;
  /** Position in the consolidated statement, 0-based. */
  sequence: number;
};

export type ConsolidationWarningCode =
  | "duplicate_page_image"
  | "overlapping_pages"
  | "duplicate_rows_removed"
  | "missing_page_numbers"
  | "page_order_uncertain"
  | "chronology_out_of_order"
  | "running_balance_gap"
  | "conflicting_statement_period"
  | "conflicting_balances"
  | "no_transaction_lines";

export type ConsolidationWarning = {
  code: ConsolidationWarningCode;
  message: string;
  pageNumbers?: number[];
};

export type ConsolidatedStatement = {
  financialInstitution: string | null;
  accountType: string | null;
  accountHolder: string | null;
  accountLastFour: string | null;
  statementStartDate: IsoDate | null;
  statementEndDate: IsoDate | null;
  beginningBalanceCents: Cents | null;
  endingBalanceCents: Cents | null;
  reportedTotalCreditsCents: Cents | null;
  reportedTotalDebitsCents: Cents | null;
  printedPageCount: number | null;
  observedPageCount: number;
  missingPrintedPages: number[];
  duplicatePageGroups: number[][];
  lines: ConsolidatedLine[];
  removedRowCount: number;
  warnings: ConsolidationWarning[];
};

export type ValidationFindingCode =
  | "balanced"
  | "out_of_balance"
  | "beginning_balance_missing"
  | "ending_balance_missing"
  | "pages_possibly_missing"
  | "pages_possibly_duplicated"
  | "amount_unreadable"
  | "columns_possibly_reversed"
  | "account_last_four_mismatch"
  | "period_overlaps_previous_reconciliation"
  | "running_balance_discontinuity"
  | "statement_period_missing"
  | "no_transactions_found";

export type ValidationSeverity = "info" | "warning" | "blocking";

export type ValidationFinding = {
  code: ValidationFindingCode;
  severity: ValidationSeverity;
  message: string;
  /** Extra structured context, kept small and free of account identifiers. */
  detail?: Record<string, string | number | null>;
};

export type ValidationStatus = "not_validated" | "balanced" | "out_of_balance" | "incomplete";

export type BalanceValidationResult = {
  status: ValidationStatus;
  totalCreditsCents: Cents;
  totalDebitsCents: Cents;
  calculatedEndingBalanceCents: Cents | null;
  balanceDifferenceCents: Cents | null;
  findings: ValidationFinding[];
  /** True when nothing blocking remains and the arithmetic proves out. */
  canConfirmWithoutOverride: boolean;
};

/** A Hallix transaction considered for matching, in bank sign convention. */
export type LedgerCandidate = {
  expenseId: string;
  date: IsoDate | null;
  signedAmountCents: Cents | null;
  vendor: string | null;
  description: string | null;
  /**
   * Normalized name needles scored one at a time (payee, merchant, memo).
   * Kept separate so a long receipt memo cannot demand words the bank never
   * prints, and so a cardholder payee cannot hide the real merchant name.
   */
  matchNames: string[];
  normalizedText: string;
  checkNumber: string | null;
  referenceNumber: string | null;
  bankAccountName: string | null;
  category: string | null;
  isAlreadyReconciled: boolean;
};

export type MatchReasonCode =
  | "exact_amount"
  | "amount_direction"
  | "amount_sign_mismatch"
  | "amount_tip"
  | "same_day"
  | "posted_after"
  | "posted_before"
  | "date_within_tolerance"
  | "date_outside_tolerance"
  | "vendor_strong"
  | "vendor_partial"
  | "vendor_weak"
  | "check_number_exact"
  | "reference_number_exact"
  | "same_bank_account"
  | "different_bank_account"
  | "unique_candidate"
  | "competing_candidate"
  | "already_reconciled"
  | "manual_selection";

export type MatchReason = {
  code: MatchReasonCode;
  /** Plain-language sentence shown to the treasurer. */
  label: string;
  points: number;
};

export type MatchStatus =
  | "unmatched"
  | "auto_matched"
  | "possible_match"
  | "manually_matched"
  | "ambiguous_duplicate"
  | "already_reconciled"
  | "outside_period"
  | "not_applicable";

export type ScoredCandidate = {
  expenseId: string;
  score: number;
  reasons: MatchReason[];
  exactAmount: boolean;
  /** Statement amount minus recorded amount, in cents. Zero when they agree. */
  amountDifferenceCents: number;
  /** The statement charge exceeds the recorded amount by a plausible gratuity. */
  likelyGratuity: boolean;
  /**
   * Statement credit/debit disagrees with Hallix. Never auto-matched; only
   * surfaced when the name, date and magnitude already agree strongly.
   */
  directionMismatch: boolean;
  dayDelta: number | null;
  vendorSimilarity: number;
  /** Distinctive words of the recorded vendor appear inside the bank description. */
  vendorContained: boolean;
  hasStrongIdentifier: boolean;
};

export type LineMatchResult = {
  fingerprint: string;
  matchStatus: MatchStatus;
  matchedExpenseId: string | null;
  matchScore: number | null;
  matchReasons: MatchReason[];
  candidateExpenseIds: string[];
};

export type MatchRunResult = {
  lines: LineMatchResult[];
  /** Hallix transactions inside the period that no statement line claimed. */
  ledgerOnlyExpenseIds: string[];
  counts: {
    matched: number;
    needsReview: number;
    statementOnly: number;
    ledgerOnly: number;
  };
};

export type PageStatus = "pending" | "reading" | "complete" | "unreadable" | "failed";

export type SessionStatus = "draft" | "review" | "confirmed" | "abandoned";

export type ExtractionStatus = "pending" | "in_progress" | "partial" | "complete" | "failed";
