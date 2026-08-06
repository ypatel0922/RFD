/**
 * New York 2% (Foreign Fire Insurance) fund analytics.
 *
 * Two deliberate positions are baked into this module:
 *
 *   1. A transaction is 2% money only because someone said so — the treasurer
 *      tagged it (`expenses.uses_two_percent_funds`) or it sits in an account
 *      the department designated (`bank_accounts.is_two_percent_account`).
 *      Nothing is inferred from an account or category containing "2%" or
 *      "foreign fire".
 *
 *   2. Utilization is a planning figure measured against a target the
 *      department chose for itself. Nothing here treats spending the balance
 *      down as a legal obligation, because whether that applies depends on the
 *      department's own structure and any special law that governs it.
 *
 * The two utilization denominators are kept separate throughout. Measuring
 * against total available money (carryover plus this year's receipts) and
 * measuring against this year's receipts alone answer different questions, and
 * a percentage is meaningless unless you know which one produced it.
 */

import { absCents, type Cents } from "../reconciliation/money";
import type { IsoDate } from "../reconciliation/dates";
import { isoFromParts, monthKey, todayIso } from "./date-range";
import type {
  AnalyticsTransaction,
  ClassifiedAccount,
  StatusLevel,
  TwoPercentBasis,
} from "./types";

export const TWO_PERCENT_DISCLAIMER =
  "Hallix provides recordkeeping, planning, and reporting support. Department officials remain responsible for confirming permitted uses and requirements applicable to their department, company, benevolent association, or special law.";

export const TWO_PERCENT_BASIS_LABELS: Record<TwoPercentBasis, string> = {
  total_available: "Total available (carryover + receipts)",
  current_year_receipts: "This year's receipts only",
};

export type TwoPercentSetupState =
  | "no_account_configured"
  | "configured_no_activity"
  | "ready";

export type TwoPercentReadiness = {
  level: StatusLevel;
  label: "Ready" | "Minor items" | "Needs review" | "Incomplete";
  openItemCount: number;
  reasons: string[];
};

export type TwoPercentSummary = {
  setupState: TwoPercentSetupState;
  reportYear: number;
  asOf: IsoDate;
  accounts: ClassifiedAccount[];

  /** Balance carried into 1 January of the report year, when it is knowable. */
  carryoverCents: Cents | null;
  receiptsCents: Cents;
  expendituresCents: Cents;
  currentBalanceCents: Cents | null;
  pendingCents: Cents;
  availableCents: Cents | null;

  basis: TwoPercentBasis;
  /** The denominator the displayed utilization is measured against. */
  denominatorCents: Cents | null;
  utilizationPercent: number | null;
  /** Utilization under both denominators, so the toggle never recomputes. */
  utilizationByBasis: Record<TwoPercentBasis, number | null>;

  targetPercent: number;
  monthlyAverageSpendCents: Cents;
  monthsElapsed: number;
  monthsRemaining: number;
  projectedYearEndSpendCents: Cents | null;
  projectedUtilizationPercent: number | null;
  projectedYearEndBalanceCents: Cents | null;
  neededPerRemainingMonthCents: Cents | null;

  missingReceiptCount: number;
  uncategorizedCount: number;
  unreconciledCount: number;
  needsReviewCount: number;
  lastReconciledAt: string | null;
  readiness: TwoPercentReadiness;

  transactionCount: number;
};

export type TwoPercentInput = {
  transactions: AnalyticsTransaction[];
  accounts: ClassifiedAccount[];
  reportYear: number;
  targetPercent: number;
  basis: TwoPercentBasis;
  /**
   * Balance in the 2% accounts at the close of the prior year. Supplied by the
   * engine from recorded opening balances and reconciled statements; null when
   * the department has not recorded anything that establishes it.
   */
  carryoverCents: Cents | null;
  pendingCents?: Cents;
  lastReconciledAt?: string | null;
  today?: IsoDate;
};

export function twoPercentTransactions(
  transactions: AnalyticsTransaction[],
): AnalyticsTransaction[] {
  return transactions.filter((transaction) => transaction.isTwoPercent);
}

export function summarizeTwoPercent(input: TwoPercentInput): TwoPercentSummary {
  const today = input.today ?? todayIso();
  const accounts = input.accounts.filter((account) => account.isTwoPercent);
  const yearPrefix = String(input.reportYear);

  const yearRows = twoPercentTransactions(input.transactions).filter(
    (transaction) => transaction.date?.startsWith(yearPrefix),
  );

  let receiptsCents = 0;
  let expendituresCents = 0;
  let missingReceiptCount = 0;
  let uncategorizedCount = 0;
  let unreconciledCount = 0;
  let needsReviewCount = 0;

  for (const row of yearRows) {
    switch (row.classification) {
      case "income":
        receiptsCents += row.magnitudeCents;
        break;
      case "expense":
        expendituresCents += row.magnitudeCents;
        if (!row.hasReceipt) missingReceiptCount += 1;
        if (!row.category) uncategorizedCount += 1;
        break;
      case "refund":
        expendituresCents -= row.magnitudeCents;
        break;
      // Transfers into or out of a 2% account move the balance but are neither
      // a receipt of 2% money nor an expenditure of it.
      case "internal_transfer":
      case "credit_card_payment":
        break;
    }
    if (!row.isReconciled) unreconciledCount += 1;
    if (
      row.twoPercentReviewStatus === "needs_review" ||
      row.twoPercentReviewStatus === "potentially_not_allowed"
    ) {
      needsReviewCount += 1;
    }
  }

  const carryoverCents = input.carryoverCents;
  const currentBalanceCents =
    carryoverCents == null ? null : carryoverCents + netMovement(yearRows);
  const pendingCents = input.pendingCents ?? 0;
  const availableCents = currentBalanceCents == null ? null : currentBalanceCents - pendingCents;

  const totalAvailableDenominator =
    carryoverCents == null ? null : carryoverCents + receiptsCents;
  const utilizationByBasis: Record<TwoPercentBasis, number | null> = {
    total_available: percentOrNull(expendituresCents, totalAvailableDenominator),
    current_year_receipts: percentOrNull(expendituresCents, receiptsCents),
  };

  const denominatorCents =
    input.basis === "total_available" ? totalAvailableDenominator : receiptsCents || null;
  const utilizationPercent = utilizationByBasis[input.basis];

  const { monthsElapsed, monthsRemaining } = yearProgress(input.reportYear, today);
  const monthlyAverageSpendCents =
    monthsElapsed === 0 ? 0 : Math.round(expendituresCents / monthsElapsed);

  const projectedYearEndSpendCents =
    monthsElapsed === 0
      ? null
      : expendituresCents + monthlyAverageSpendCents * monthsRemaining;
  const projectedUtilizationPercent = percentOrNull(
    projectedYearEndSpendCents,
    denominatorCents,
  );
  const projectedYearEndBalanceCents =
    denominatorCents == null || projectedYearEndSpendCents == null
      ? null
      : denominatorCents - projectedYearEndSpendCents;

  const targetSpendCents =
    denominatorCents == null
      ? null
      : Math.round((denominatorCents * input.targetPercent) / 100);
  const neededPerRemainingMonthCents =
    targetSpendCents == null || monthsRemaining === 0
      ? null
      : Math.max(0, Math.round((targetSpendCents - expendituresCents) / monthsRemaining));

  const readiness = assessReadiness({
    missingReceiptCount,
    uncategorizedCount,
    unreconciledCount,
    needsReviewCount,
    hasCarryover: carryoverCents != null,
    transactionCount: yearRows.length,
  });

  const setupState: TwoPercentSetupState = !accounts.length
    ? "no_account_configured"
    : yearRows.length === 0
      ? "configured_no_activity"
      : "ready";

  return {
    setupState,
    reportYear: input.reportYear,
    asOf: today,
    accounts,
    carryoverCents,
    receiptsCents,
    expendituresCents,
    currentBalanceCents,
    pendingCents,
    availableCents,
    basis: input.basis,
    denominatorCents,
    utilizationPercent,
    utilizationByBasis,
    targetPercent: input.targetPercent,
    monthlyAverageSpendCents,
    monthsElapsed,
    monthsRemaining,
    projectedYearEndSpendCents,
    projectedUtilizationPercent,
    projectedYearEndBalanceCents,
    neededPerRemainingMonthCents,
    missingReceiptCount,
    uncategorizedCount,
    unreconciledCount,
    needsReviewCount,
    lastReconciledAt: input.lastReconciledAt ?? null,
    readiness,
    transactionCount: yearRows.length,
  };
}

/**
 * A percentage, or null when the denominator cannot support one. Returning null
 * rather than 0 or Infinity keeps "we cannot say" distinct from "it is zero".
 */
export function percentOrNull(
  numerator: number | null,
  denominator: number | null,
): number | null {
  if (numerator == null || denominator == null) return null;
  if (denominator === 0) return null;
  return (numerator / denominator) * 100;
}

function netMovement(rows: AnalyticsTransaction[]): Cents {
  let total = 0;
  for (const row of rows) {
    if (row.signedCents != null) total += row.signedCents;
  }
  return total;
}

/**
 * How far through the report year the "as of" date sits. A closed prior year
 * counts as fully elapsed; a future year has not started.
 */
export function yearProgress(
  reportYear: number,
  today: IsoDate,
): { monthsElapsed: number; monthsRemaining: number } {
  const currentYear = Number(today.slice(0, 4));
  if (currentYear > reportYear) return { monthsElapsed: 12, monthsRemaining: 0 };
  if (currentYear < reportYear) return { monthsElapsed: 0, monthsRemaining: 12 };
  const month = Number(today.slice(5, 7));
  return { monthsElapsed: month, monthsRemaining: 12 - month };
}

function assessReadiness(input: {
  missingReceiptCount: number;
  uncategorizedCount: number;
  unreconciledCount: number;
  needsReviewCount: number;
  hasCarryover: boolean;
  transactionCount: number;
}): TwoPercentReadiness {
  const reasons: string[] = [];
  if (input.missingReceiptCount > 0) {
    reasons.push(
      `${input.missingReceiptCount} 2% expense${input.missingReceiptCount === 1 ? "" : "s"} without a receipt`,
    );
  }
  if (input.uncategorizedCount > 0) {
    reasons.push(
      `${input.uncategorizedCount} 2% expense${input.uncategorizedCount === 1 ? "" : "s"} without a category`,
    );
  }
  if (input.unreconciledCount > 0) {
    reasons.push(
      `${input.unreconciledCount} 2% transaction${input.unreconciledCount === 1 ? "" : "s"} not yet reconciled`,
    );
  }
  if (input.needsReviewCount > 0) {
    reasons.push(
      `${input.needsReviewCount} 2% expense${input.needsReviewCount === 1 ? "" : "s"} flagged for review`,
    );
  }
  if (!input.hasCarryover) {
    reasons.push("No opening balance recorded for the 2% account, so carryover cannot be shown");
  }

  const openItemCount =
    input.missingReceiptCount +
    input.uncategorizedCount +
    input.unreconciledCount +
    input.needsReviewCount;

  if (input.transactionCount === 0) {
    return {
      level: "unknown",
      label: "Incomplete",
      openItemCount,
      reasons: ["No 2% activity recorded for this year yet"],
    };
  }
  if (openItemCount === 0 && input.hasCarryover) {
    return { level: "positive", label: "Ready", openItemCount, reasons: [] };
  }
  if (openItemCount === 0) {
    return { level: "neutral", label: "Minor items", openItemCount, reasons };
  }
  if (openItemCount <= 3) {
    return { level: "neutral", label: "Minor items", openItemCount, reasons };
  }
  return { level: "attention", label: "Needs review", openItemCount, reasons };
}

// ─── Category breakdown ───────────────────────────────────────────────────────

export type TwoPercentCategoryRow = {
  category: string;
  amountCents: Cents;
  percentOfExpenditures: number;
  transactionCount: number;
  missingDocumentationCount: number;
  changeCents: Cents | null;
};

export function twoPercentByCategory(options: {
  current: AnalyticsTransaction[];
  prior?: AnalyticsTransaction[] | null;
  reportYear: number;
  priorYear?: number;
}): TwoPercentCategoryRow[] {
  const currentTotals = groupTwoPercentExpenses(options.current, options.reportYear);
  const priorTotals = options.prior
    ? groupTwoPercentExpenses(options.prior, options.priorYear ?? options.reportYear - 1)
    : null;

  const grandTotal = [...currentTotals.values()].reduce((sum, entry) => sum + entry.amount, 0);

  return [...currentTotals.entries()]
    .map(([category, entry]) => ({
      category,
      amountCents: entry.amount,
      percentOfExpenditures: grandTotal === 0 ? 0 : (entry.amount / grandTotal) * 100,
      transactionCount: entry.count,
      missingDocumentationCount: entry.missingDocs,
      changeCents: priorTotals ? entry.amount - (priorTotals.get(category)?.amount ?? 0) : null,
    }))
    .sort((a, b) => b.amountCents - a.amountCents);
}

function groupTwoPercentExpenses(transactions: AnalyticsTransaction[], year: number) {
  const map = new Map<string, { amount: Cents; count: number; missingDocs: number }>();
  const prefix = String(year);
  for (const row of transactions) {
    if (!row.isTwoPercent) continue;
    if (row.classification !== "expense") continue;
    if (!row.date?.startsWith(prefix)) continue;
    const key = row.category || "Uncategorized";
    const entry = map.get(key) ?? { amount: 0, count: 0, missingDocs: 0 };
    entry.amount += row.magnitudeCents;
    entry.count += 1;
    if (!row.hasReceipt) entry.missingDocs += 1;
    map.set(key, entry);
  }
  return map;
}

// ─── Monthly 2% spend, for the pacing chart ───────────────────────────────────

export function twoPercentMonthlySpend(
  transactions: AnalyticsTransaction[],
  reportYear: number,
): Array<{ monthKey: string; amountCents: Cents }> {
  const buckets = new Map<string, Cents>();
  for (let month = 1; month <= 12; month += 1) {
    buckets.set(monthKey(isoFromParts(reportYear, month, 1)), 0);
  }
  for (const row of transactions) {
    if (!row.isTwoPercent || !row.date) continue;
    const key = monthKey(row.date);
    if (!buckets.has(key)) continue;
    if (row.classification === "expense") {
      buckets.set(key, (buckets.get(key) ?? 0) + row.magnitudeCents);
    } else if (row.classification === "refund") {
      buckets.set(key, (buckets.get(key) ?? 0) - row.magnitudeCents);
    }
  }
  return [...buckets.entries()].map(([key, amountCents]) => ({ monthKey: key, amountCents }));
}

/**
 * Balance in the 2% accounts at the close of the year before `reportYear`.
 *
 * Uses whichever anchor the department has actually recorded, then rolls ledger
 * activity forward to 31 December. With no anchor there is no honest answer, so
 * this returns null and the dashboard shows "not recorded" instead of zero.
 */
export function carryoverForYear(options: {
  accounts: ClassifiedAccount[];
  transactions: AnalyticsTransaction[];
  reportYear: number;
  anchorsByAccountId: Map<string, { cents: Cents; date: IsoDate | null }>;
}): Cents | null {
  const twoPercentIds = new Set(
    options.accounts.filter((account) => account.isTwoPercent).map((account) => account.id),
  );
  if (!twoPercentIds.size) return null;

  const anchored = [...twoPercentIds].filter((id) => options.anchorsByAccountId.has(id));
  if (!anchored.length) return null;

  const cutoff = isoFromParts(options.reportYear - 1, 12, 31);
  let total = 0;

  for (const accountId of anchored) {
    const anchor = options.anchorsByAccountId.get(accountId);
    if (!anchor) continue;
    total += anchor.cents;
    for (const row of options.transactions) {
      if (row.accountId !== accountId) continue;
      if (row.signedCents == null || !row.date) continue;
      if (anchor.date && row.date <= anchor.date) continue;
      if (row.date > cutoff) continue;
      total += row.signedCents;
    }
  }

  return total;
}

export function twoPercentSpendPaceStatus(summary: TwoPercentSummary): {
  level: StatusLevel;
  label: string;
  explanation: string;
} {
  if (summary.utilizationPercent == null) {
    return {
      level: "unknown",
      label: "Insufficient data",
      explanation:
        "Utilization needs both an opening balance and recorded 2% activity before it can be calculated.",
    };
  }

  const expectedPercent = (summary.targetPercent * summary.monthsElapsed) / 12;
  const difference = summary.utilizationPercent - expectedPercent;

  if (Math.abs(difference) <= 10) {
    return {
      level: "positive",
      label: "On pace",
      explanation: `${summary.utilizationPercent.toFixed(0)}% used against roughly ${expectedPercent.toFixed(0)}% expected ${summary.monthsElapsed} month${summary.monthsElapsed === 1 ? "" : "s"} into the year.`,
    };
  }
  if (difference > 10) {
    return {
      level: "attention",
      label: "Ahead of pace",
      explanation: `${summary.utilizationPercent.toFixed(0)}% used against roughly ${expectedPercent.toFixed(0)}% expected at this point in the year.`,
    };
  }
  return {
    level: "neutral",
    label: "Behind pace",
    explanation: `${summary.utilizationPercent.toFixed(0)}% used against roughly ${expectedPercent.toFixed(0)}% expected at this point in the year.`,
  };
}

export function absoluteCents(value: Cents | null): Cents | null {
  return value == null ? null : absCents(value);
}
