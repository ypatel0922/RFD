/**
 * Documentation, reconciliation and audit-readiness measures.
 *
 * "Audit readiness" here means one thing only: how complete the department's
 * own records are. Hallix does not audit anything and does not issue an
 * opinion, so this module never produces the words "compliant" or "certified",
 * and its status labels describe recordkeeping rather than conclusions.
 */

import { absDaysBetween, type IsoDate } from "../reconciliation/dates";
import { todayIso } from "./date-range";
import type { AnalyticsTransaction, ClassifiedAccount, StatusLevel } from "./types";

export const STALE_RECONCILIATION_DAYS = 30;
export const STALE_ACCOUNT_RECONCILIATION_DAYS = 45;

export type ReadinessLabel = "Ready" | "Minor items" | "Needs review" | "Incomplete";

export type DocumentationMetrics = {
  expenseCount: number;
  withReceiptCount: number;
  missingReceiptCount: number;
  /** Null when there are no expenses to measure, rather than a misleading 100%. */
  receiptCompletionPercent: number | null;

  missingDescriptionCount: number;
  uncategorizedCount: number;

  reconciledCount: number;
  unreconciledCount: number;
  reconciliationCompletionPercent: number | null;
  staleUnreconciledCount: number;

  flaggedDuplicateCount: number;
  needsReviewCount: number;

  accountsNeedingReconciliation: Array<{
    account: ClassifiedAccount;
    lastReconciledAt: string | null;
    daysSince: number | null;
  }>;

  openExceptionCount: number;
  readiness: { level: StatusLevel; label: ReadinessLabel; reasons: string[] };
};

export function documentationMetrics(options: {
  transactions: AnalyticsTransaction[];
  accounts: ClassifiedAccount[];
  today?: IsoDate;
}): DocumentationMetrics {
  const today = options.today ?? todayIso();

  let expenseCount = 0;
  let withReceiptCount = 0;
  let missingDescriptionCount = 0;
  let uncategorizedCount = 0;
  let reconciledCount = 0;
  let unreconciledCount = 0;
  let staleUnreconciledCount = 0;
  let flaggedDuplicateCount = 0;
  let needsReviewCount = 0;

  for (const transaction of options.transactions) {
    if (transaction.classification === "expense") {
      expenseCount += 1;
      if (transaction.hasReceipt) withReceiptCount += 1;
      if (!transaction.category) uncategorizedCount += 1;
      if (!transaction.hasDescription) missingDescriptionCount += 1;
    }

    if (transaction.isReconciled) {
      reconciledCount += 1;
    } else {
      unreconciledCount += 1;
      const age = absDaysBetween(today, transaction.date);
      if (age != null && age > STALE_RECONCILIATION_DAYS) staleUnreconciledCount += 1;
    }

    if (transaction.isFlaggedDuplicate) flaggedDuplicateCount += 1;
    if (
      transaction.twoPercentReviewStatus === "needs_review" ||
      transaction.twoPercentReviewStatus === "potentially_not_allowed"
    ) {
      needsReviewCount += 1;
    }
  }

  const missingReceiptCount = expenseCount - withReceiptCount;
  const totalCount = reconciledCount + unreconciledCount;

  const accountsNeedingReconciliation = options.accounts
    .map((account) => {
      const daysSince = account.lastReconciledAt
        ? absDaysBetween(today, account.lastReconciledAt.slice(0, 10))
        : null;
      return { account, lastReconciledAt: account.lastReconciledAt, daysSince };
    })
    .filter(
      (row) => row.daysSince == null || row.daysSince > STALE_ACCOUNT_RECONCILIATION_DAYS,
    );

  const openExceptionCount =
    missingReceiptCount + uncategorizedCount + flaggedDuplicateCount + staleUnreconciledCount;

  return {
    expenseCount,
    withReceiptCount,
    missingReceiptCount,
    receiptCompletionPercent: expenseCount === 0 ? null : (withReceiptCount / expenseCount) * 100,
    missingDescriptionCount,
    uncategorizedCount,
    reconciledCount,
    unreconciledCount,
    reconciliationCompletionPercent:
      totalCount === 0 ? null : (reconciledCount / totalCount) * 100,
    staleUnreconciledCount,
    flaggedDuplicateCount,
    needsReviewCount,
    accountsNeedingReconciliation,
    openExceptionCount,
    readiness: assessReadiness({
      transactionCount: totalCount,
      missingReceiptCount,
      uncategorizedCount,
      staleUnreconciledCount,
      flaggedDuplicateCount,
      accountsNeedingReconciliationCount: accountsNeedingReconciliation.length,
    }),
  };
}

function assessReadiness(input: {
  transactionCount: number;
  missingReceiptCount: number;
  uncategorizedCount: number;
  staleUnreconciledCount: number;
  flaggedDuplicateCount: number;
  accountsNeedingReconciliationCount: number;
}): { level: StatusLevel; label: ReadinessLabel; reasons: string[] } {
  if (input.transactionCount === 0) {
    return {
      level: "unknown",
      label: "Incomplete",
      reasons: ["No transactions recorded for this period yet"],
    };
  }

  const reasons: string[] = [];
  if (input.missingReceiptCount > 0) {
    reasons.push(`${input.missingReceiptCount} expense${plural(input.missingReceiptCount)} without a receipt`);
  }
  if (input.uncategorizedCount > 0) {
    reasons.push(`${input.uncategorizedCount} expense${plural(input.uncategorizedCount)} without a category`);
  }
  if (input.staleUnreconciledCount > 0) {
    reasons.push(
      `${input.staleUnreconciledCount} transaction${plural(input.staleUnreconciledCount)} unreconciled for more than ${STALE_RECONCILIATION_DAYS} days`,
    );
  }
  if (input.flaggedDuplicateCount > 0) {
    reasons.push(`${input.flaggedDuplicateCount} possible duplicate${plural(input.flaggedDuplicateCount)} to review`);
  }
  if (input.accountsNeedingReconciliationCount > 0) {
    reasons.push(
      `${input.accountsNeedingReconciliationCount} account${plural(input.accountsNeedingReconciliationCount)} not reconciled recently`,
    );
  }

  if (!reasons.length) return { level: "positive", label: "Ready", reasons };

  const weighted =
    input.missingReceiptCount +
    input.uncategorizedCount +
    input.staleUnreconciledCount * 2 +
    input.flaggedDuplicateCount * 2;

  if (weighted <= 3) return { level: "neutral", label: "Minor items", reasons };
  if (weighted <= 12) return { level: "attention", label: "Needs review", reasons };
  return { level: "risk", label: "Needs review", reasons };
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}
