/**
 * Hallix Department Health.
 *
 * This is a recordkeeping and financial-position indicator, not an audit
 * opinion, a legal conclusion, or a compliance certification. The naming is
 * kept deliberately plain for that reason.
 *
 * Two rules shape the scoring:
 *
 *   1. A department is never marked down for being new. Components only score
 *      when the underlying data exists; a department with three transactions
 *      is not "at risk", it is unmeasured, and the overall status says
 *      "Insufficient data" instead of inventing a number.
 *
 *   2. Every component explains itself and links to the records behind it, so
 *      the score is always arguable rather than mysterious.
 */

import type { Cents } from "../reconciliation/money";
import type { CashPosition } from "./aggregate";
import type { BudgetSummary } from "./budgets";
import type { DocumentationMetrics } from "./documentation";
import type { TwoPercentSummary } from "./two-percent";
import type { DrilldownTarget, StatusLevel } from "./types";

/** Below this, percentages are too noisy to describe a department's habits. */
export const MIN_TRANSACTIONS_FOR_SCORE = 10;

export type HealthStatusLabel = "Strong" | "Good" | "Needs Attention" | "At Risk";

export type HealthComponent = {
  id: string;
  label: string;
  level: StatusLevel;
  /** 0–100, or null when this component has nothing to measure. */
  score: number | null;
  weight: number;
  detail: string;
  /** How the component was computed, shown in the explanation panel. */
  method: string;
  drilldown: DrilldownTarget | null;
  actionLabel: string | null;
};

export type DepartmentHealth = {
  /** Null when there is not enough data to score honestly. */
  score: number | null;
  status: HealthStatusLabel | null;
  level: StatusLevel;
  headline: string;
  hasSufficientData: boolean;
  insufficientDataReason: string | null;
  components: HealthComponent[];
  methodology: string;
};

export type HealthInput = {
  documentation: DocumentationMetrics;
  cash: CashPosition;
  twoPercent: TwoPercentSummary | null;
  budgets: BudgetSummary | null;
  transactionCount: number;
  negativeAccountCount: number;
};

export function assessDepartmentHealth(input: HealthInput): DepartmentHealth {
  const components: HealthComponent[] = [
    reconciliationComponent(input.documentation),
    receiptComponent(input.documentation),
    categorizationComponent(input.documentation),
    exceptionsComponent(input.documentation),
    cashComponent(input.cash, input.negativeAccountCount),
    creditCardComponent(input.cash),
    twoPercentComponent(input.twoPercent),
    budgetComponent(input.budgets),
  ].filter((component): component is HealthComponent => component !== null);

  const scored = components.filter((component) => component.score != null);

  if (input.transactionCount < MIN_TRANSACTIONS_FOR_SCORE || scored.length < 2) {
    return {
      score: null,
      status: null,
      level: "unknown",
      headline: "Insufficient data",
      hasSufficientData: false,
      insufficientDataReason:
        input.transactionCount < MIN_TRANSACTIONS_FOR_SCORE
          ? `Health scoring starts once at least ${MIN_TRANSACTIONS_FOR_SCORE} transactions are recorded. Hallix has ${input.transactionCount}.`
          : "Not enough of the underlying measures have data yet to combine into a score.",
      components,
      methodology: METHODOLOGY,
    };
  }

  const totalWeight = scored.reduce((sum, component) => sum + component.weight, 0);
  const weighted = scored.reduce(
    (sum, component) => sum + (component.score ?? 0) * component.weight,
    0,
  );
  const score = Math.round(weighted / totalWeight);

  return {
    score,
    status: statusForScore(score),
    level: levelForScore(score),
    headline: headlineForScore(score, components),
    hasSufficientData: true,
    insufficientDataReason: null,
    components,
    methodology: METHODOLOGY,
  };
}

const METHODOLOGY =
  "Hallix Department Health combines the measures below into a weighted average. Only measures that have data contribute, so a department with a short history is not marked down for it. This is an indicator of recordkeeping and financial position — it is not an audit, an audit opinion, or a determination of compliance with any law or regulation.";

function statusForScore(score: number): HealthStatusLabel {
  if (score >= 85) return "Strong";
  if (score >= 70) return "Good";
  if (score >= 50) return "Needs Attention";
  return "At Risk";
}

function levelForScore(score: number): StatusLevel {
  if (score >= 85) return "positive";
  if (score >= 70) return "neutral";
  if (score >= 50) return "attention";
  return "risk";
}

function headlineForScore(score: number, components: HealthComponent[]): string {
  const weakest = components
    .filter((component) => component.score != null)
    .sort((a, b) => (a.score ?? 100) - (b.score ?? 100))[0];

  if (score >= 85) return "Records are in good order and the financial position looks healthy.";
  if (score >= 70) {
    return weakest
      ? `Generally in good shape. ${weakest.label} is the weakest area.`
      : "Generally in good shape.";
  }
  return weakest
    ? `Several areas need attention, starting with ${weakest.label.toLowerCase()}.`
    : "Several areas need attention.";
}

// ─── Components ───────────────────────────────────────────────────────────────

function reconciliationComponent(documentation: DocumentationMetrics): HealthComponent {
  const percent = documentation.reconciliationCompletionPercent;
  return {
    id: "reconciliation",
    label: "Reconciliation",
    weight: 3,
    score: percent,
    level: percent == null ? "unknown" : thresholdLevel(percent, 95, 80, 60),
    detail:
      percent == null
        ? "No transactions to reconcile in this period."
        : `${documentation.reconciledCount} of ${documentation.reconciledCount + documentation.unreconciledCount} transactions reconciled.`,
    method: "The share of transactions in this period marked as reconciled against a bank record.",
    drilldown: { kind: "reconciliation", queue: "unreconciled" },
    actionLabel: documentation.unreconciledCount > 0 ? "Open reconciliation" : null,
  };
}

function receiptComponent(documentation: DocumentationMetrics): HealthComponent {
  const percent = documentation.receiptCompletionPercent;
  return {
    id: "receipts",
    label: "Receipts",
    weight: 3,
    score: percent,
    level: percent == null ? "unknown" : thresholdLevel(percent, 95, 85, 65),
    detail:
      percent == null
        ? "No expenses recorded in this period."
        : `${documentation.withReceiptCount} of ${documentation.expenseCount} expenses have a receipt attached.`,
    method: "The share of expenses in this period with a stored receipt file.",
    drilldown: { kind: "transactions", filters: { quickFilter: "missing_receipt" } },
    actionLabel: documentation.missingReceiptCount > 0 ? "Review missing receipts" : null,
  };
}

function categorizationComponent(documentation: DocumentationMetrics): HealthComponent {
  if (documentation.expenseCount === 0) {
    return {
      id: "categorization",
      label: "Categorization",
      weight: 2,
      score: null,
      level: "unknown",
      detail: "No expenses recorded in this period.",
      method: "The share of expenses in this period that carry a category.",
      drilldown: null,
      actionLabel: null,
    };
  }
  const categorized = documentation.expenseCount - documentation.uncategorizedCount;
  const percent = (categorized / documentation.expenseCount) * 100;
  return {
    id: "categorization",
    label: "Categorization",
    weight: 2,
    score: percent,
    level: thresholdLevel(percent, 98, 90, 75),
    detail: `${documentation.uncategorizedCount} expense${documentation.uncategorizedCount === 1 ? "" : "s"} still need a category.`,
    method: "The share of expenses in this period that carry a category.",
    drilldown: { kind: "transactions", filters: { quickFilter: "needs_review" } },
    actionLabel: documentation.uncategorizedCount > 0 ? "Categorize transactions" : null,
  };
}

function exceptionsComponent(documentation: DocumentationMetrics): HealthComponent {
  const exceptions = documentation.staleUnreconciledCount + documentation.flaggedDuplicateCount;
  const total = documentation.reconciledCount + documentation.unreconciledCount;

  if (total === 0) {
    return {
      id: "exceptions",
      label: "Open exceptions",
      weight: 2,
      score: null,
      level: "unknown",
      detail: "No transactions to check in this period.",
      method:
        "Counts stale unreconciled transactions and possible duplicates, measured against the number of transactions.",
      drilldown: null,
      actionLabel: null,
    };
  }

  const score = Math.max(0, 100 - (exceptions / total) * 100 * 4);
  return {
    id: "exceptions",
    label: "Open exceptions",
    weight: 2,
    score,
    level: exceptions === 0 ? "positive" : thresholdLevel(score, 95, 80, 60),
    detail:
      exceptions === 0
        ? "No stale or duplicate-flagged transactions."
        : `${documentation.staleUnreconciledCount} unreconciled beyond 30 days, ${documentation.flaggedDuplicateCount} flagged as possible duplicates.`,
    method:
      "Counts stale unreconciled transactions and possible duplicates, measured against the number of transactions.",
    drilldown: { kind: "reconciliation", queue: "duplicate" },
    actionLabel: exceptions > 0 ? "Review exceptions" : null,
  };
}

function cashComponent(cash: CashPosition, negativeAccountCount: number): HealthComponent {
  if (cash.hasIncompleteBalances && cash.totalCashCents === 0) {
    return {
      id: "cash",
      label: "Cash position",
      weight: 3,
      score: null,
      level: "unknown",
      detail: "No account balances are established yet.",
      method:
        "Checks whether the net liquid position (cash minus card balances) is positive and no account is negative.",
      drilldown: { kind: "accounts" },
      actionLabel: "Review accounts",
    };
  }

  let score = 100;
  if (cash.netLiquidCents < 0) score = 25;
  else if (cash.netLiquidCents === 0) score = 50;
  if (negativeAccountCount > 0) score = Math.min(score, 40);

  return {
    id: "cash",
    label: "Cash position",
    weight: 3,
    score,
    level: levelForScore(score),
    detail:
      negativeAccountCount > 0
        ? `${negativeAccountCount} account${negativeAccountCount === 1 ? " has" : "s have"} a negative balance.`
        : cash.netLiquidCents < 0
          ? "Card balances currently exceed available cash."
          : "Cash exceeds outstanding card balances.",
    method:
      "Checks whether the net liquid position (cash minus card balances) is positive and no account is negative.",
    drilldown: { kind: "accounts" },
    actionLabel: "Review accounts",
  };
}

function creditCardComponent(cash: CashPosition): HealthComponent | null {
  if (cash.creditCardBalanceCents <= 0) return null;

  const coverage = cash.totalCashCents / cash.creditCardBalanceCents;
  const score = coverage >= 3 ? 100 : coverage >= 1.5 ? 85 : coverage >= 1 ? 65 : 35;

  return {
    id: "credit_cards",
    label: "Card balances",
    weight: 1,
    score,
    level: levelForScore(score),
    detail: `Cash covers outstanding card balances ${coverage.toFixed(1)} times over.`,
    method: "Compares total cash against total outstanding credit card balances.",
    drilldown: { kind: "accounts" },
    actionLabel: "Review accounts",
  };
}

function twoPercentComponent(summary: TwoPercentSummary | null): HealthComponent | null {
  if (!summary || summary.setupState === "no_account_configured") return null;

  if (summary.transactionCount === 0) {
    return {
      id: "two_percent",
      label: "2% reporting readiness",
      weight: 2,
      score: null,
      level: "unknown",
      detail: "No 2% activity recorded for this year yet.",
      method:
        "Counts 2% expenses missing a receipt or category, and 2% transactions not yet reconciled.",
      drilldown: { kind: "transactions", filters: { quickFilter: "two_percent" } },
      actionLabel: null,
    };
  }

  const openItems = summary.readiness.openItemCount;
  const score = Math.max(0, 100 - (openItems / Math.max(1, summary.transactionCount)) * 100 * 2);

  return {
    id: "two_percent",
    label: "2% reporting readiness",
    weight: 2,
    score,
    level: openItems === 0 ? "positive" : levelForScore(score),
    detail:
      openItems === 0
        ? "2% records are complete for the year so far."
        : `${openItems} open item${openItems === 1 ? "" : "s"} on 2% records.`,
    method:
      "Counts 2% expenses missing a receipt or category, and 2% transactions not yet reconciled, against the number of 2% transactions.",
    drilldown: { kind: "transactions", filters: { quickFilter: "two_percent" } },
    actionLabel: openItems > 0 ? "Open 2% transactions" : null,
  };
}

function budgetComponent(budgets: BudgetSummary | null): HealthComponent | null {
  if (!budgets?.hasBudgets) return null;

  const total = budgets.lines.length;
  const penalty = budgets.overBudgetCount * 20 + budgets.approachingCount * 5;
  const score = Math.max(0, 100 - penalty);

  return {
    id: "budgets",
    label: "Budget adherence",
    weight: 2,
    score,
    level: budgets.overBudgetCount === 0 ? "positive" : levelForScore(score),
    detail:
      budgets.overBudgetCount === 0
        ? `No categories over budget out of ${total}.`
        : `${budgets.overBudgetCount} of ${total} budget categories are over.`,
    method: "Counts budget categories that are over or approaching their planned amount.",
    drilldown: null,
    actionLabel: null,
  };
}

function thresholdLevel(
  value: number,
  strong: number,
  good: number,
  attention: number,
): StatusLevel {
  if (value >= strong) return "positive";
  if (value >= good) return "neutral";
  if (value >= attention) return "attention";
  return "risk";
}
