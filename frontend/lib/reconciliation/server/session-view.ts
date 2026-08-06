/**
 * Assembles the payload the reconciliation wizard renders.
 *
 * Money crosses the wire as integer cents so the browser never re-parses a
 * decimal string, and the review screen totals agree with the server exactly.
 */

import { formatPeriod, type IsoDate } from "../dates";
import { ledgerSignedCents, ledgerVendorName, type LedgerExpenseRow } from "../ledger";
import { parseCents, type Cents } from "../money";
import type {
  ConsolidationWarning,
  MatchReason,
  MatchStatus,
  PageStatus,
  SessionStatus,
  ValidationFinding,
  ValidationStatus,
} from "../types";
import type { PageRow, SessionRow, StatementLineRow } from "./data-access";

export type SessionViewPage = {
  clientPageId: string;
  pageOrder: number;
  status: PageStatus;
  statusDetail: string | null;
  lineCount: number;
  printedPageNumber: number | null;
  printedPageCount: number | null;
  warnings: string[];
};

export type SessionViewLine = {
  id: string;
  fingerprint: string;
  postedDate: IsoDate | null;
  transactionDate: IsoDate | null;
  originalDescription: string | null;
  normalizedDescription: string | null;
  signedAmountCents: Cents | null;
  runningBalanceCents: Cents | null;
  checkNumber: string | null;
  referenceNumber: string | null;
  pageNumber: number;
  rowNumber: number;
  sectionHeading: string | null;
  extractionConfidence: number | null;
  extractionWarning: string | null;
  matchStatus: MatchStatus;
  matchedExpenseId: string | null;
  matchScore: number | null;
  matchReasons: MatchReason[];
  candidateExpenseIds: string[];
  manuallyCorrected: boolean;
  confirmed: boolean;
};

export type SessionViewExpense = {
  id: string;
  date: IsoDate | null;
  signedAmountCents: Cents | null;
  vendor: string | null;
  description: string | null;
  category: string | null;
  bankAccountName: string | null;
  paymentReference: string | null;
  isAlreadyReconciled: boolean;
};

export type SessionView = {
  session: {
    id: string;
    departmentId: string;
    bankAccountId: string | null;
    bankAccountName: string | null;
    status: SessionStatus;
    extractionStatus: string;
    statementStartDate: IsoDate | null;
    statementEndDate: IsoDate | null;
    statementPeriodLabel: string;
    beginningBalanceCents: Cents | null;
    endingBalanceCents: Cents | null;
    totalCreditsCents: Cents | null;
    totalDebitsCents: Cents | null;
    calculatedEndingBalanceCents: Cents | null;
    balanceDifferenceCents: Cents | null;
    validationStatus: ValidationStatus;
    validationFindings: ValidationFinding[];
    consolidationWarnings: ConsolidationWarning[];
    statementInstitution: string | null;
    statementAccountType: string | null;
    statementAccountLastFour: string | null;
    statementAccountHolder: string | null;
    printedPageCount: number | null;
    pageCount: number;
    matchedCount: number;
    needsReviewCount: number;
    statementOnlyCount: number;
    ledgerOnlyCount: number;
    confirmedAt: string | null;
    confirmedByEmail: string | null;
    confirmedTransactionCount: number;
    overrideReason: string | null;
    createdAt: string;
    expiresAt: string;
  };
  pages: SessionViewPage[];
  lines: SessionViewLine[];
  ledgerOnlyExpenseIds: string[];
  expenses: Record<string, SessionViewExpense>;
};

type StatementMetadata = {
  institution?: string | null;
  accountType?: string | null;
  accountLastFour?: string | null;
  accountHolder?: string | null;
  printedPageCount?: number | null;
  consolidationWarnings?: ConsolidationWarning[];
};

export function buildSessionView(input: {
  session: SessionRow;
  pages: PageRow[];
  lines: StatementLineRow[];
  ledgerRows: LedgerExpenseRow[];
}): SessionView {
  const metadata = (input.session.statement_metadata || {}) as StatementMetadata;

  const lines = input.lines.map(toViewLine);
  const ledgerOnlyExpenseIds = input.session.ledger_only_expense_ids ?? [];

  // Only ship the transactions the screen actually references.
  const referenced = new Set<string>(ledgerOnlyExpenseIds);
  for (const line of lines) {
    if (line.matchedExpenseId) referenced.add(line.matchedExpenseId);
    for (const candidateId of line.candidateExpenseIds) referenced.add(candidateId);
  }

  const expenses: Record<string, SessionViewExpense> = {};
  for (const row of input.ledgerRows) {
    if (!referenced.has(row.id)) continue;
    expenses[row.id] = toViewExpense(row);
  }

  return {
    session: {
      id: input.session.id,
      departmentId: input.session.department_id,
      bankAccountId: input.session.bank_account_id,
      bankAccountName: input.session.bank_account_name,
      status: input.session.status,
      extractionStatus: input.session.extraction_status,
      statementStartDate: input.session.statement_start_date,
      statementEndDate: input.session.statement_end_date,
      statementPeriodLabel: formatPeriod(
        input.session.statement_start_date,
        input.session.statement_end_date,
      ),
      beginningBalanceCents: parseCents(input.session.beginning_balance),
      endingBalanceCents: parseCents(input.session.ending_balance),
      totalCreditsCents: parseCents(input.session.total_credits),
      totalDebitsCents: parseCents(input.session.total_debits),
      calculatedEndingBalanceCents: parseCents(input.session.calculated_ending_balance),
      balanceDifferenceCents: parseCents(input.session.balance_difference),
      validationStatus: input.session.validation_status,
      validationFindings: input.session.validation_findings ?? [],
      consolidationWarnings: metadata.consolidationWarnings ?? [],
      statementInstitution: metadata.institution ?? null,
      statementAccountType: metadata.accountType ?? null,
      statementAccountLastFour: metadata.accountLastFour ?? null,
      statementAccountHolder: metadata.accountHolder ?? null,
      printedPageCount: metadata.printedPageCount ?? null,
      pageCount: input.session.page_count,
      matchedCount: input.session.matched_count,
      needsReviewCount: input.session.needs_review_count,
      statementOnlyCount: input.session.statement_only_count,
      ledgerOnlyCount: input.session.ledger_only_count,
      confirmedAt: input.session.confirmed_at,
      confirmedByEmail: input.session.confirmed_by_email,
      confirmedTransactionCount: input.session.confirmed_transaction_count,
      overrideReason: input.session.override_reason,
      createdAt: input.session.created_at,
      expiresAt: input.session.expires_at,
    },
    pages: input.pages.map(toViewPage),
    lines,
    ledgerOnlyExpenseIds,
    expenses,
  };
}

function toViewPage(row: PageRow): SessionViewPage {
  return {
    clientPageId: row.client_page_id,
    pageOrder: row.page_order,
    status: row.status,
    statusDetail: row.status_detail,
    lineCount: row.line_count,
    printedPageNumber: row.extracted_header?.printedPageNumber ?? null,
    printedPageCount: row.extracted_header?.printedPageCount ?? null,
    warnings: row.extraction_warnings ?? [],
  };
}

function toViewLine(row: StatementLineRow): SessionViewLine {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    postedDate: row.posted_date,
    transactionDate: row.transaction_date,
    originalDescription: row.original_description,
    normalizedDescription: row.normalized_description,
    signedAmountCents: parseCents(row.signed_amount),
    runningBalanceCents: parseCents(row.running_balance),
    checkNumber: row.check_number,
    referenceNumber: row.reference_number,
    pageNumber: row.page_number,
    rowNumber: row.row_number,
    sectionHeading: row.section_heading,
    extractionConfidence: row.extraction_confidence == null ? null : Number(row.extraction_confidence),
    extractionWarning: row.extraction_warning,
    matchStatus: row.match_status,
    matchedExpenseId: row.matched_expense_id,
    matchScore: row.match_score == null ? null : Number(row.match_score),
    matchReasons: row.match_reasons ?? [],
    candidateExpenseIds: row.candidate_expense_ids ?? [],
    manuallyCorrected: row.manually_corrected,
    confirmed: Boolean(row.confirmed_at),
  };
}

function toViewExpense(row: LedgerExpenseRow): SessionViewExpense {
  return {
    id: row.id,
    date: row.transaction_date ? row.transaction_date.slice(0, 10) : null,
    signedAmountCents: ledgerSignedCents(row),
    vendor: ledgerVendorName(row),
    description: row.description,
    category: row.category,
    bankAccountName: row.bank_account_name,
    paymentReference: row.payment_reference,
    isAlreadyReconciled: row.reconciliation_status === "matched" && Boolean(row.reconciled_at),
  };
}
