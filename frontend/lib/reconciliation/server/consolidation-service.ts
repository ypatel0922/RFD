/**
 * Runs pass 2 end to end and saves the result.
 *
 * Consolidate -> validate -> match -> persist, in that order, because each step
 * depends on the previous one: matching needs the resolved statement period, and
 * validation needs the deduplicated line set. Re-running is safe and idempotent;
 * it is triggered whenever a page is added, replaced, reordered or removed.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { dateToleranceDays } from "../config";
import { consolidateStatement, type PageForConsolidation } from "../consolidate";
import { normalizeStatementDate, type IsoDate } from "../dates";
import {
  normalizeCheckNumber,
  normalizeDescription,
  normalizeReferenceNumber,
} from "../description";
import { matchStatementToLedger } from "../matching";
import { centsToNumeric, parseCents, type Cents } from "../money";
import type { LedgerExpenseRow } from "../ledger";
import type { ConsolidatedLine, LineMatchResult } from "../types";
import { validateStatement } from "../validate";
import type { BankAccountForReconciliation } from "./auth";
import {
  loadConfirmedSessionsForAccount,
  loadLedgerCandidates,
  loadPages,
  loadStatementLines,
  lockedDecisionsFrom,
  replaceStatementLines,
  updateSession,
  type SessionRow,
} from "./data-access";

export type ManualStatementOverrides = {
  beginningBalanceCents?: Cents | null;
  endingBalanceCents?: Cents | null;
  statementStartDate?: IsoDate | null;
  statementEndDate?: IsoDate | null;
};

/**
 * A treasurer's correction to a value the model misread. Keyed by the line's
 * fingerprint, which is derived from the *extracted* values and therefore stays
 * stable while the underlying page result does. Re-reading that page produces
 * new fingerprints, which correctly drops corrections that no longer apply.
 */
export type LineCorrection = {
  postedDate?: string | null;
  originalDescription?: string | null;
  signedAmountCents?: Cents | null;
  checkNumber?: string | null;
  referenceNumber?: string | null;
};

type StoredMetadata = {
  manual?: {
    beginningBalanceCents?: Cents | null;
    endingBalanceCents?: Cents | null;
    statementStartDate?: string | null;
    statementEndDate?: string | null;
  };
  lineCorrections?: Record<string, LineCorrection>;
};

export type ConsolidationOutcome = {
  session: SessionRow;
  /** Ledger rows already loaded for matching, reused to build the response. */
  ledgerRows: LedgerExpenseRow[];
};

export async function runConsolidation(input: {
  supabase: SupabaseClient;
  session: SessionRow;
  bankAccount: BankAccountForReconciliation | null;
  overrides?: ManualStatementOverrides;
  /** Corrections to merge in before validating. Replaces any stored value. */
  lineCorrections?: Record<string, LineCorrection>;
}): Promise<ConsolidationOutcome> {
  const { supabase, session } = input;
  const departmentId = session.department_id;

  const storedMetadata = (session.statement_metadata || {}) as StoredMetadata;
  const manual = mergeManualOverrides(storedMetadata.manual, input.overrides);
  const lineCorrections: Record<string, LineCorrection> = {
    ...(storedMetadata.lineCorrections ?? {}),
    ...(input.lineCorrections ?? {}),
  };

  const pages = await loadPages(supabase, session.id);
  const readablePages = pages.filter((page) => page.status === "complete" && page.extracted_header);

  const forConsolidation: PageForConsolidation[] = readablePages.map((page) => ({
    clientPageId: page.client_page_id,
    pageOrder: page.page_order,
    imageDigest: page.image_digest,
    header: page.extracted_header!,
    lines: page.extracted_lines ?? [],
  }));

  const accountKey = session.bank_account_id ?? departmentId;
  const consolidated = consolidateStatement(forConsolidation, { accountKey });
  const statement = {
    ...consolidated,
    lines: applyLineCorrections(consolidated.lines, lineCorrections),
  };

  const statementStartDate = manual.statementStartDate ?? statement.statementStartDate;
  const statementEndDate = manual.statementEndDate ?? statement.statementEndDate;

  const previousReconciliations = session.bank_account_id
    ? await loadConfirmedSessionsForAccount(supabase, departmentId, session.bank_account_id, session.id)
    : [];

  const validation = validateStatement({
    statement: { ...statement, statementStartDate, statementEndDate },
    selectedAccountLastFour: input.bankAccount?.account_mask ?? null,
    previousReconciliations,
    manualBeginningBalanceCents: manual.beginningBalanceCents ?? null,
    manualEndingBalanceCents: manual.endingBalanceCents ?? null,
  });

  const { candidates, rows } = await loadLedgerCandidates(supabase, {
    departmentId,
    statementStartDate,
    statementEndDate,
  });

  const existingLines = await loadStatementLines(supabase, session.id);
  const lockedLines = lockedDecisionsFrom(existingLines);

  const matchRun = matchStatementToLedger({
    lines: statement.lines,
    candidates,
    statementStartDate,
    statementEndDate,
    selectedAccountName: session.bank_account_name,
    dateToleranceDays: dateToleranceDays(),
    lockedLines,
  });

  const matchesByFingerprint = new Map<string, LineMatchResult>(
    matchRun.lines.map((line) => [line.fingerprint, line]),
  );

  const manualFingerprints = new Set<string>([
    ...Object.keys(lockedLines),
    ...Object.keys(lineCorrections),
  ]);

  await replaceStatementLines(supabase, {
    sessionId: session.id,
    departmentId,
    lines: statement.lines,
    matches: matchesByFingerprint,
    manualFingerprints,
  });

  const beginningBalanceCents = manual.beginningBalanceCents ?? statement.beginningBalanceCents;
  const endingBalanceCents = manual.endingBalanceCents ?? statement.endingBalanceCents;

  const unreadablePageCount = pages.filter(
    (page) => page.status === "unreadable" || page.status === "failed",
  ).length;
  const pendingPageCount = pages.filter(
    (page) => page.status === "pending" || page.status === "reading",
  ).length;

  const updatedSession = await updateSession(supabase, session.id, departmentId, {
    statement_start_date: statementStartDate,
    statement_end_date: statementEndDate,
    beginning_balance: centsToNumeric(beginningBalanceCents),
    ending_balance: centsToNumeric(endingBalanceCents),
    total_credits: centsToNumeric(validation.totalCreditsCents),
    total_debits: centsToNumeric(validation.totalDebitsCents),
    calculated_ending_balance: centsToNumeric(validation.calculatedEndingBalanceCents),
    balance_difference: centsToNumeric(validation.balanceDifferenceCents),
    validation_status: validation.status,
    validation_findings: validation.findings,
    statement_metadata: {
      institution: statement.financialInstitution,
      accountType: statement.accountType,
      accountLastFour: statement.accountLastFour,
      accountHolder: statement.accountHolder,
      printedPageCount: statement.printedPageCount,
      missingPrintedPages: statement.missingPrintedPages,
      duplicatePageGroups: statement.duplicatePageGroups,
      removedRowCount: statement.removedRowCount,
      consolidationWarnings: statement.warnings,
      manual,
      lineCorrections,
    },
    page_count: readablePages.length,
    extraction_status:
      pendingPageCount > 0
        ? "in_progress"
        : unreadablePageCount > 0
          ? "partial"
          : readablePages.length > 0
            ? "complete"
            : "pending",
    status: session.status === "draft" ? "review" : session.status,
    matched_count: matchRun.counts.matched,
    needs_review_count: matchRun.counts.needsReview,
    statement_only_count: matchRun.counts.statementOnly,
    ledger_only_count: matchRun.counts.ledgerOnly,
    ledger_only_expense_ids: matchRun.ledgerOnlyExpenseIds,
  });

  return { session: updatedSession, ledgerRows: rows };
}

/**
 * Overlay treasurer corrections onto the freshly consolidated lines. Only the
 * fields actually corrected are replaced; the fingerprint, page and row stay put
 * so traceability back to the photograph survives the edit.
 */
function applyLineCorrections(
  lines: ConsolidatedLine[],
  corrections: Record<string, LineCorrection>,
): ConsolidatedLine[] {
  if (!Object.keys(corrections).length) return lines;

  return lines.map((line) => {
    const correction = corrections[line.fingerprint];
    if (!correction) return line;

    const description =
      correction.originalDescription !== undefined && correction.originalDescription !== null
        ? correction.originalDescription
        : line.originalDescription;

    const signedAmountCents =
      correction.signedAmountCents !== undefined
        ? correction.signedAmountCents
        : line.signedAmountCents;

    const postedDate =
      correction.postedDate !== undefined
        ? normalizeStatementDate(correction.postedDate)
        : line.postedDate;

    return {
      ...line,
      postedDate,
      originalDescription: description,
      normalizedDescription: normalizeDescription(description),
      signedAmountCents,
      debitAmountCents:
        signedAmountCents != null && signedAmountCents < 0 ? -signedAmountCents : null,
      creditAmountCents:
        signedAmountCents != null && signedAmountCents > 0 ? signedAmountCents : null,
      checkNumber:
        correction.checkNumber !== undefined
          ? normalizeCheckNumber(correction.checkNumber)
          : line.checkNumber,
      referenceNumber:
        correction.referenceNumber !== undefined
          ? normalizeReferenceNumber(correction.referenceNumber)
          : line.referenceNumber,
      // A corrected value is authoritative, so the model's own doubt no longer
      // applies to this row.
      extractionConfidence: 1,
      extractionWarning: null,
    };
  });
}

function mergeManualOverrides(
  stored: StoredMetadata["manual"],
  incoming: ManualStatementOverrides | undefined,
): {
  beginningBalanceCents: Cents | null;
  endingBalanceCents: Cents | null;
  statementStartDate: IsoDate | null;
  statementEndDate: IsoDate | null;
} {
  return {
    beginningBalanceCents:
      incoming?.beginningBalanceCents !== undefined
        ? incoming.beginningBalanceCents
        : (stored?.beginningBalanceCents ?? null),
    endingBalanceCents:
      incoming?.endingBalanceCents !== undefined
        ? incoming.endingBalanceCents
        : (stored?.endingBalanceCents ?? null),
    statementStartDate:
      incoming?.statementStartDate !== undefined
        ? incoming.statementStartDate
        : normalizeStatementDate(stored?.statementStartDate ?? null),
    statementEndDate:
      incoming?.statementEndDate !== undefined
        ? incoming.statementEndDate
        : normalizeStatementDate(stored?.statementEndDate ?? null),
  };
}

/** Parse a treasurer-entered balance from the wizard's correction fields. */
export function parseManualBalance(value: unknown): Cents | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return parseCents(value);
}
