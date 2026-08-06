/**
 * Statement balance validation.
 *
 * The controlling identity for an asset (bank) account is
 *
 *     beginning balance + credits - debits = ending balance
 *
 * All arithmetic is in integer cents. Anything more than a one-cent rounding
 * difference means a row was misread, a page is missing, or a debit was read as
 * a credit -- and the treasurer is told which, rather than being shown a bare
 * "out of balance" number.
 */

import { BALANCE_TOLERANCE_CENTS } from "./config";
import { periodsOverlap, type IsoDate } from "./dates";
import { absCents, sumCents, formatCents, type Cents } from "./money";
import { findRunningBalanceGaps } from "./running-balance";
import type {
  BalanceValidationResult,
  ConsolidatedStatement,
  ValidationFinding,
  ValidationStatus,
} from "./types";

export type PreviousReconciliation = {
  sessionId: string;
  statementStartDate: IsoDate | null;
  statementEndDate: IsoDate | null;
};

export type ValidateStatementInput = {
  statement: ConsolidatedStatement;
  /** Last four digits recorded on the selected Hallix account, when known. */
  selectedAccountLastFour: string | null;
  /** Confirmed reconciliations already recorded for the selected account. */
  previousReconciliations: PreviousReconciliation[];
  /** Treasurer-supplied balances when the statement photo could not be read. */
  manualBeginningBalanceCents?: Cents | null;
  manualEndingBalanceCents?: Cents | null;
};

export function validateStatement(input: ValidateStatementInput): BalanceValidationResult {
  const { statement } = input;
  const findings: ValidationFinding[] = [];

  const beginningBalanceCents = input.manualBeginningBalanceCents ?? statement.beginningBalanceCents;
  const endingBalanceCents = input.manualEndingBalanceCents ?? statement.endingBalanceCents;

  const postedLines = statement.lines.filter((line) => !line.isPending);
  const pendingCount = statement.lines.length - postedLines.length;

  const unreadableAmounts = postedLines.filter((line) => line.signedAmountCents == null);
  const totalCreditsCents = sumCents(
    postedLines.map((line) => (line.signedAmountCents != null && line.signedAmountCents > 0 ? line.signedAmountCents : 0)),
  );
  const totalDebitsCents = absCents(
    sumCents(
      postedLines.map((line) => (line.signedAmountCents != null && line.signedAmountCents < 0 ? line.signedAmountCents : 0)),
    ),
  );

  const calculatedEndingBalanceCents =
    beginningBalanceCents == null ? null : beginningBalanceCents + totalCreditsCents - totalDebitsCents;

  const balanceDifferenceCents =
    calculatedEndingBalanceCents == null || endingBalanceCents == null
      ? null
      : endingBalanceCents - calculatedEndingBalanceCents;

  // --- Structural problems that make the arithmetic unprovable -------------

  if (!statement.statementStartDate || !statement.statementEndDate) {
    findings.push({
      code: "statement_period_missing",
      severity: "blocking",
      message:
        "The statement dates could not be read. Add a clearer photo of the page showing the statement period, or enter the dates yourself.",
    });
  }

  if (beginningBalanceCents == null) {
    findings.push({
      code: "beginning_balance_missing",
      severity: "blocking",
      message:
        "The beginning balance could not be read. It is usually on the first page. Add that page or type the balance in.",
    });
  }

  if (endingBalanceCents == null) {
    findings.push({
      code: "ending_balance_missing",
      severity: "blocking",
      message:
        "The ending balance could not be read. It is usually on the first or last page. Add that page or type the balance in.",
    });
  }

  if (!postedLines.length) {
    findings.push({
      code: "no_transactions_found",
      severity: "blocking",
      message:
        "No posted transactions were read from these pages. Add photos of the transaction list.",
    });
  }

  if (unreadableAmounts.length) {
    const first = unreadableAmounts[0];
    findings.push({
      code: "amount_unreadable",
      severity: "blocking",
      message: `${unreadableAmounts.length} transaction amount${unreadableAmounts.length === 1 ? "" : "s"} could not be read. Retake the photo of page ${[...new Set(unreadableAmounts.map((line) => line.pageNumber))].join(", ")} or correct the amount.`,
      detail: { page_number: first.pageNumber, row_number: first.rowNumber, count: unreadableAmounts.length },
    });
  }

  if (statement.missingPrintedPages.length) {
    findings.push({
      code: "pages_possibly_missing",
      severity: "blocking",
      message: `The statement says it has ${statement.printedPageCount} pages but page ${statement.missingPrintedPages.join(", ")} ${statement.missingPrintedPages.length === 1 ? "was" : "were"} not added.`,
      detail: { missing_pages: statement.missingPrintedPages.join(","), printed_page_count: statement.printedPageCount },
    });
  }

  if (statement.duplicatePageGroups.length) {
    findings.push({
      code: "pages_possibly_duplicated",
      severity: "warning",
      message:
        "The same page photo was added more than once. Duplicates were ignored, but check the page list.",
      detail: { duplicate_groups: statement.duplicatePageGroups.length },
    });
  }

  const runningBalanceGaps = findRunningBalanceGaps(statement.lines, beginningBalanceCents);
  if (runningBalanceGaps.length) {
    const first = runningBalanceGaps[0];
    findings.push({
      code: "running_balance_discontinuity",
      severity: "blocking",
      message: `The running balance stops adding up on page ${first.pageNumber}, row ${first.rowNumber}: the statement shows ${formatCents(first.reportedCents)} where the transactions give ${formatCents(first.expectedCents)}. A row on that page is probably missing or misread.`,
      detail: {
        page_number: first.pageNumber,
        row_number: first.rowNumber,
        difference: formatCents(first.differenceCents),
        gap_count: runningBalanceGaps.length,
      },
    });
  }

  // --- Account identity ----------------------------------------------------

  if (
    input.selectedAccountLastFour &&
    statement.accountLastFour &&
    normalizeLastFour(input.selectedAccountLastFour) !== normalizeLastFour(statement.accountLastFour)
  ) {
    findings.push({
      code: "account_last_four_mismatch",
      severity: "blocking",
      message:
        "The last four digits on this statement do not match the Hallix account you selected. Go back and pick the right account, or check that this is the correct statement.",
    });
  }

  // --- Period overlap with an already-completed reconciliation -------------

  const overlapping = input.previousReconciliations.filter((previous) =>
    periodsOverlap(
      statement.statementStartDate,
      statement.statementEndDate,
      previous.statementStartDate,
      previous.statementEndDate,
    ),
  );
  if (overlapping.length) {
    findings.push({
      code: "period_overlaps_previous_reconciliation",
      severity: "warning",
      message:
        "This statement period overlaps a reconciliation you already completed for this account. Transactions reconciled before will not be reconciled again.",
      detail: { overlapping_sessions: overlapping.length },
    });
  }

  // --- The balance itself --------------------------------------------------

  if (balanceDifferenceCents != null) {
    if (absCents(balanceDifferenceCents) <= BALANCE_TOLERANCE_CENTS) {
      findings.push({
        code: "balanced",
        severity: "info",
        message: "The statement balances: beginning balance plus deposits minus withdrawals equals the ending balance.",
      });
    } else {
      const reversalHint = detectReversedColumns({
        beginningBalanceCents,
        endingBalanceCents,
        totalCreditsCents,
        totalDebitsCents,
      });
      findings.push({
        code: "out_of_balance",
        severity: "blocking",
        message: `The statement is off by ${formatCents(absCents(balanceDifferenceCents))}. Beginning balance ${formatCents(beginningBalanceCents)} plus deposits ${formatCents(totalCreditsCents)} minus withdrawals ${formatCents(totalDebitsCents)} gives ${formatCents(calculatedEndingBalanceCents)}, but the statement shows ${formatCents(endingBalanceCents)}.`,
        detail: { difference: formatCents(balanceDifferenceCents) },
      });
      if (reversalHint) {
        findings.push({
          code: "columns_possibly_reversed",
          severity: "warning",
          message:
            "The statement balances if the deposit and withdrawal columns are swapped. Check that deposits and withdrawals were read from the right columns.",
        });
      }
    }
  }

  const status = deriveStatus(findings, balanceDifferenceCents);

  return {
    status,
    totalCreditsCents,
    totalDebitsCents,
    calculatedEndingBalanceCents,
    balanceDifferenceCents,
    findings: pendingCount
      ? [
          ...findings,
          {
            code: "balanced",
            severity: "info",
            message: `${pendingCount} pending transaction${pendingCount === 1 ? "" : "s"} were excluded. Pending items are not part of a statement's balance.`,
          } satisfies ValidationFinding,
        ]
      : findings,
    canConfirmWithoutOverride: status === "balanced",
  };
}

function deriveStatus(
  findings: ValidationFinding[],
  balanceDifferenceCents: Cents | null,
): ValidationStatus {
  const hasBlocking = findings.some((finding) => finding.severity === "blocking");
  if (hasBlocking) {
    // Distinguish "we could not prove it" from "we proved it is wrong" so the UI
    // can ask for a missing page rather than an override reason.
    return findings.some((finding) => finding.code === "out_of_balance")
      ? "out_of_balance"
      : "incomplete";
  }
  if (balanceDifferenceCents == null) return "incomplete";
  return absCents(balanceDifferenceCents) <= BALANCE_TOLERANCE_CENTS ? "balanced" : "out_of_balance";
}

/**
 * A reversed debit/credit column reading produces a very specific signature: the
 * statement balances exactly when the two totals are swapped. Anything else is
 * an ordinary out-of-balance and should not be blamed on the columns.
 */
function detectReversedColumns({
  beginningBalanceCents,
  endingBalanceCents,
  totalCreditsCents,
  totalDebitsCents,
}: {
  beginningBalanceCents: Cents | null;
  endingBalanceCents: Cents | null;
  totalCreditsCents: Cents;
  totalDebitsCents: Cents;
}): boolean {
  if (beginningBalanceCents == null || endingBalanceCents == null) return false;
  if (totalCreditsCents === totalDebitsCents) return false;
  const swapped = beginningBalanceCents + totalDebitsCents - totalCreditsCents;
  return absCents(endingBalanceCents - swapped) <= BALANCE_TOLERANCE_CENTS;
}

function normalizeLastFour(value: string): string {
  return value.replace(/\D/g, "").slice(-4);
}
