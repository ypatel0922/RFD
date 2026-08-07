/**
 * Insight generation.
 *
 * Every insight is produced here, by arithmetic, from figures that were already
 * computed and displayed elsewhere on the page. Each one carries the exact
 * metrics it was derived from in `citations`, plus the rule that produced it in
 * `method`, so a treasurer can always answer "where did this come from?".
 *
 * A language model may later rephrase an insight's title and summary into
 * friendlier wording, but it is never given the arithmetic to do and can never
 * introduce a finding. If the rewrite fails validation the deterministic text
 * stands. See `app/api/analytics/insights-narrative/route.ts`.
 */

import { absCents, type Cents } from "../reconciliation/money";
import { absDaysBetween } from "../reconciliation/dates";
import type { AccountActivity, CashPosition, CategoryTotal, VendorTotal } from "./aggregate";
import type { BudgetSummary } from "./budgets";
import type { CashFlowSummary } from "./cash-flow";
import type { DocumentationMetrics } from "./documentation";
import { STALE_ACCOUNT_RECONCILIATION_DAYS } from "./documentation";
import { formatCount, formatMoney, formatPercent, formatSignedPercent } from "./format";
import type { TwoPercentSummary } from "./two-percent";
import { twoPercentSpendPaceStatus } from "./two-percent";
import type {
  AnalyticsPeriod,
  DrilldownTarget,
  InsightSeverity,
  MetricCitation,
} from "./types";

export type Insight = {
  id: string;
  severity: InsightSeverity;
  title: string;
  summary: string;
  /** The exact figures this insight was generated from. */
  citations: MetricCitation[];
  comparisonLabel: string | null;
  recommendedAction: string;
  drilldown: DrilldownTarget | null;
  actionLabel: string | null;
  /** Plain description of the rule, shown in the "how was this calculated" tip. */
  method: string;
  /** Used to order insights of equal severity; larger is more prominent. */
  rank: number;
};

export const INSIGHT_SEVERITY_LABELS: Record<InsightSeverity, string> = {
  action_needed: "Action needed",
  watch: "Watch",
  positive: "Positive",
  informational: "Informational",
};

const SEVERITY_ORDER: Record<InsightSeverity, number> = {
  action_needed: 0,
  watch: 1,
  positive: 2,
  informational: 3,
};

/** A category or vendor must move by at least this much to be worth reporting. */
const MATERIAL_CHANGE_CENTS = 25_000;
const MATERIAL_CHANGE_PERCENT = 25;
const VENDOR_CONCENTRATION_PERCENT = 30;

export type InsightInput = {
  period: AnalyticsPeriod;
  documentation: DocumentationMetrics;
  priorDocumentation: DocumentationMetrics | null;
  categories: CategoryTotal[];
  vendors: VendorTotal[];
  accounts: AccountActivity[];
  cash: CashPosition;
  cashFlow: CashFlowSummary;
  twoPercent: TwoPercentSummary | null;
  budgets: BudgetSummary | null;
};

export function generateInsights(input: InsightInput): Insight[] {
  const insights: Insight[] = [
    ...twoPercentInsights(input),
    ...documentationInsights(input),
    ...reconciliationInsights(input),
    ...spendingInsights(input),
    ...vendorInsights(input),
    ...budgetInsights(input),
    ...cashInsights(input),
  ];

  return insights
    .sort((a, b) => {
      const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      return bySeverity !== 0 ? bySeverity : b.rank - a.rank;
    })
    .slice(0, 12);
}

function cite(label: string, value: string, rawValue: number | null = null): MetricCitation {
  return { label, value, rawValue };
}

// ─── 2% fund ──────────────────────────────────────────────────────────────────

function twoPercentInsights(input: InsightInput): Insight[] {
  const summary = input.twoPercent;
  if (!summary || summary.setupState === "no_account_configured") return [];

  const insights: Insight[] = [];

  if (summary.utilizationPercent != null) {
    const pace = twoPercentSpendPaceStatus(summary);

    if (pace.level === "attention") {
      insights.push({
        id: "two_percent_ahead_of_pace",
        severity: "watch",
        title: "2% spending is running ahead of the department's plan",
        summary: `${formatPercent(summary.utilizationPercent)} of the 2% funds tracked for ${summary.reportYear} has been spent ${summary.monthsElapsed} month${summary.monthsElapsed === 1 ? "" : "s"} into the year, ahead of the department's own pace toward its ${formatPercent(summary.targetPercent)} target.`,
        citations: [
          cite("Spent this year", formatMoney(summary.expendituresCents), summary.expendituresCents),
          cite("Measured against", formatMoney(summary.denominatorCents), summary.denominatorCents),
          cite("Utilization", formatPercent(summary.utilizationPercent), summary.utilizationPercent),
          cite("Department target", formatPercent(summary.targetPercent), summary.targetPercent),
        ],
        comparisonLabel: `${summary.monthsElapsed} of 12 months elapsed`,
        recommendedAction:
          "Review planned 2% purchases for the rest of the year so the balance lasts as intended.",
        drilldown: { kind: "transactions", filters: { quickFilter: "two_percent" } },
        actionLabel: "View 2% transactions",
        method:
          "Compares 2% spending as a share of the selected denominator against the share of the year that has elapsed, using the department's own target.",
        rank: Math.abs(summary.utilizationPercent - (summary.targetPercent * summary.monthsElapsed) / 12),
      });
    }

    if (
      summary.projectedUtilizationPercent != null &&
      summary.projectedUtilizationPercent < summary.targetPercent - 10 &&
      summary.monthsRemaining > 0
    ) {
      insights.push({
        id: "two_percent_below_target",
        severity: "watch",
        title: "Projected 2% use is below the department's target",
        summary: `At the current pace the department would use about ${formatPercent(summary.projectedUtilizationPercent)} of its 2% funds this year, short of the ${formatPercent(summary.targetPercent)} it set for itself.`,
        citations: [
          cite("Spent so far", formatMoney(summary.expendituresCents), summary.expendituresCents),
          cite("Monthly average", formatMoney(summary.monthlyAverageSpendCents), summary.monthlyAverageSpendCents),
          cite("Projected year-end use", formatPercent(summary.projectedUtilizationPercent), summary.projectedUtilizationPercent),
          cite("Department target", formatPercent(summary.targetPercent), summary.targetPercent),
          cite(
            "Needed per remaining month",
            formatMoney(summary.neededPerRemainingMonthCents),
            summary.neededPerRemainingMonthCents,
          ),
        ],
        comparisonLabel: `${summary.monthsRemaining} month${summary.monthsRemaining === 1 ? "" : "s"} remaining`,
        recommendedAction:
          "If the department intends to reach its target, plan eligible purchases now rather than late in the year. This is a planning target the department chose, not a legal deadline.",
        drilldown: { kind: "transactions", filters: { quickFilter: "two_percent" } },
        actionLabel: "View 2% transactions",
        method:
          "Projects current monthly average 2% spending across the remaining months and compares the result with the department's target.",
        rank: summary.targetPercent - summary.projectedUtilizationPercent,
      });
    }
  }

  if (summary.missingReceiptCount > 0 || summary.uncategorizedCount > 0) {
    const openItems = summary.missingReceiptCount + summary.uncategorizedCount;
    insights.push({
      id: "two_percent_documentation",
      severity: "action_needed",
      title: "2% records are incomplete for the annual report",
      summary: `${formatCount(summary.missingReceiptCount, "2% expense")} ${summary.missingReceiptCount === 1 ? "is" : "are"} missing a receipt and ${formatCount(summary.uncategorizedCount, "is", "are")} missing a category.`,
      citations: [
        cite("Missing receipts", String(summary.missingReceiptCount), summary.missingReceiptCount),
        cite("Uncategorized", String(summary.uncategorizedCount), summary.uncategorizedCount),
        cite("2% transactions this year", String(summary.transactionCount), summary.transactionCount),
      ],
      comparisonLabel: `${summary.reportYear} to date`,
      recommendedAction: "Attach the missing receipts and set categories before preparing the annual report.",
      drilldown: { kind: "transactions", filters: { quickFilter: "two_percent" } },
      actionLabel: "Fix 2% records",
      method: "Counts 2% expenses in the report year with no stored receipt or no category.",
      rank: openItems * 10,
    });
  }

  if (summary.unreconciledCount > 0) {
    insights.push({
      id: "two_percent_unreconciled",
      severity: "watch",
      title: "Some 2% transactions are not reconciled",
      summary: `${formatCount(summary.unreconciledCount, "2% transaction")} from ${summary.reportYear} ${summary.unreconciledCount === 1 ? "has" : "have"} not been matched to a bank record.`,
      citations: [
        cite("Unreconciled 2% transactions", String(summary.unreconciledCount), summary.unreconciledCount),
        cite("2% transactions this year", String(summary.transactionCount), summary.transactionCount),
      ],
      comparisonLabel: `${summary.reportYear} to date`,
      recommendedAction: "Reconcile the 2% account so the annual report figures tie to the bank.",
      drilldown: { kind: "reconciliation", queue: "unreconciled" },
      actionLabel: "Open reconciliation",
      method: "Counts 2% transactions in the report year whose reconciliation status is not matched.",
      rank: summary.unreconciledCount * 5,
    });
  }

  if (
    summary.setupState === "ready" &&
    summary.readiness.label === "Ready" &&
    summary.transactionCount > 0
  ) {
    insights.push({
      id: "two_percent_ready",
      severity: "positive",
      title: "2% records are ready for annual reporting",
      summary: `All ${formatCount(summary.transactionCount, "2% transaction")} for ${summary.reportYear} ${summary.transactionCount === 1 ? "has" : "have"} a receipt, a category, and a reconciled bank match.`,
      citations: [
        cite("2% transactions this year", String(summary.transactionCount), summary.transactionCount),
        cite("Open items", "0", 0),
      ],
      comparisonLabel: `${summary.reportYear} to date`,
      recommendedAction: "No action needed. The annual report can be prepared from these records.",
      drilldown: { kind: "transactions", filters: { quickFilter: "two_percent" } },
      actionLabel: "View 2% transactions",
      method: "Checks that no 2% expense in the report year is missing a receipt, category, or reconciliation.",
      rank: 1,
    });
  }

  return insights;
}

// ─── Documentation ────────────────────────────────────────────────────────────

function documentationInsights(input: InsightInput): Insight[] {
  const { documentation, priorDocumentation } = input;
  const insights: Insight[] = [];

  if (documentation.missingReceiptCount >= 3) {
    insights.push({
      id: "missing_receipts",
      severity: documentation.missingReceiptCount >= 10 ? "action_needed" : "watch",
      title: `${formatCount(documentation.missingReceiptCount, "expense")} ${documentation.missingReceiptCount === 1 ? "is" : "are"} missing a receipt`,
      summary: `${formatPercent(documentation.receiptCompletionPercent)} of expenses in this period have a receipt attached.`,
      citations: [
        cite("Missing receipts", String(documentation.missingReceiptCount), documentation.missingReceiptCount),
        cite("Expenses in period", String(documentation.expenseCount), documentation.expenseCount),
        cite("Receipt completion", formatPercent(documentation.receiptCompletionPercent), documentation.receiptCompletionPercent),
      ],
      comparisonLabel: input.period.label,
      recommendedAction: "Request the missing receipts while the purchases are still recent.",
      drilldown: { kind: "transactions", filters: { quickFilter: "missing_receipt" } },
      actionLabel: "Open missing receipts",
      method: "Counts expenses in the selected period with no stored receipt file.",
      rank: documentation.missingReceiptCount,
    });
  }

  if (
    priorDocumentation?.receiptCompletionPercent != null &&
    documentation.receiptCompletionPercent != null &&
    documentation.receiptCompletionPercent - priorDocumentation.receiptCompletionPercent >= 10
  ) {
    const improvement =
      documentation.receiptCompletionPercent - priorDocumentation.receiptCompletionPercent;
    insights.push({
      id: "documentation_improved",
      severity: "positive",
      title: "Receipt documentation improved",
      summary: `Receipt completion rose to ${formatPercent(documentation.receiptCompletionPercent)} from ${formatPercent(priorDocumentation.receiptCompletionPercent)} in the comparison period.`,
      citations: [
        cite("This period", formatPercent(documentation.receiptCompletionPercent), documentation.receiptCompletionPercent),
        cite("Comparison period", formatPercent(priorDocumentation.receiptCompletionPercent), priorDocumentation.receiptCompletionPercent),
        cite("Change", formatSignedPercent(improvement), improvement),
      ],
      comparisonLabel: input.period.comparisonLabel,
      recommendedAction: "No action needed. Keep the current receipt-collection habit going.",
      drilldown: null,
      actionLabel: null,
      method: "Compares receipt completion in the selected period against the comparison period.",
      rank: improvement,
    });
  }

  if (documentation.flaggedDuplicateCount > 0) {
    insights.push({
      id: "possible_duplicates",
      severity: "watch",
      title: `${formatCount(documentation.flaggedDuplicateCount, "transaction")} flagged as a possible duplicate`,
      summary:
        "Hallix found transactions that look like they may already have been recorded from a bank statement or import.",
      citations: [
        cite("Flagged transactions", String(documentation.flaggedDuplicateCount), documentation.flaggedDuplicateCount),
      ],
      comparisonLabel: input.period.label,
      recommendedAction: "Review each flagged transaction and remove or confirm it.",
      drilldown: { kind: "reconciliation", queue: "duplicate" },
      actionLabel: "Review duplicates",
      method: "Counts transactions carrying the reconciliation duplicate-candidate flag.",
      rank: documentation.flaggedDuplicateCount * 3,
    });
  }

  return insights;
}

// ─── Reconciliation ───────────────────────────────────────────────────────────

function reconciliationInsights(input: InsightInput): Insight[] {
  const { documentation, priorDocumentation } = input;
  const insights: Insight[] = [];

  const current = documentation.reconciliationCompletionPercent;
  const prior = priorDocumentation?.reconciliationCompletionPercent ?? null;

  if (current != null && prior != null && prior - current >= 15) {
    insights.push({
      id: "reconciliation_declined",
      severity: "watch",
      title: "Reconciliation has fallen behind",
      summary: `${formatPercent(current)} of transactions are reconciled, down from ${formatPercent(prior)} in the comparison period.`,
      citations: [
        cite("This period", formatPercent(current), current),
        cite("Comparison period", formatPercent(prior), prior),
        cite("Unreconciled now", String(documentation.unreconciledCount), documentation.unreconciledCount),
      ],
      comparisonLabel: input.period.comparisonLabel,
      recommendedAction: "Run a reconciliation session to catch up before the backlog grows.",
      drilldown: { kind: "reconciliation", queue: "unreconciled" },
      actionLabel: "Open reconciliation",
      method: "Compares the reconciled share of transactions against the comparison period.",
      rank: prior - current,
    });
  }

  if (current === 100 && documentation.reconciledCount > 0) {
    insights.push({
      id: "reconciliation_complete",
      severity: "positive",
      title: "Every transaction in this period is reconciled",
      summary: `All ${formatCount(documentation.reconciledCount, "transaction")} in the selected period ${documentation.reconciledCount === 1 ? "has" : "have"} been matched to a bank record.`,
      citations: [cite("Reconciled", String(documentation.reconciledCount), documentation.reconciledCount)],
      comparisonLabel: input.period.label,
      recommendedAction: "No action needed.",
      drilldown: null,
      actionLabel: null,
      method: "Checks that no transaction in the selected period is left unreconciled.",
      rank: 1,
    });
  }

  for (const row of documentation.accountsNeedingReconciliation.slice(0, 2)) {
    insights.push({
      id: `account_stale_${row.account.id}`,
      severity: "watch",
      title: `${row.account.name} has not been reconciled recently`,
      summary:
        row.daysSince == null
          ? `${row.account.name} has no recorded reconciliation yet.`
          : `The last reconciliation of ${row.account.name} was ${row.daysSince} days ago.`,
      citations: [
        cite("Account", row.account.name),
        cite("Days since reconciliation", row.daysSince == null ? "Never" : String(row.daysSince), row.daysSince),
      ],
      comparisonLabel: null,
      recommendedAction: "Reconcile this account against its latest statement.",
      drilldown: { kind: "reconciliation", queue: "unreconciled" },
      actionLabel: "Open reconciliation",
      method: `Flags accounts with no reconciliation recorded in the last ${STALE_ACCOUNT_RECONCILIATION_DAYS} days.`,
      rank: row.daysSince ?? 999,
    });
  }

  return insights;
}

// ─── Spending ─────────────────────────────────────────────────────────────────

function spendingInsights(input: InsightInput): Insight[] {
  const insights: Insight[] = [];

  const increases = input.categories
    .filter((category) => category.change.hasComparison)
    .filter(
      (category) =>
        category.change.deltaCents >= MATERIAL_CHANGE_CENTS &&
        (category.change.percent ?? 0) >= MATERIAL_CHANGE_PERCENT,
    )
    .sort((a, b) => b.change.deltaCents - a.change.deltaCents)
    .slice(0, 2);

  for (const category of increases) {
    insights.push({
      id: `category_increase_${category.category}`,
      severity: "watch",
      title: `${category.category} spending is up materially`,
      summary: `${category.category} reached ${formatMoney(category.amountCents)}, ${formatMoney(absCents(category.change.deltaCents))} more than the comparison period.`,
      citations: [
        cite("This period", formatMoney(category.amountCents), category.amountCents),
        cite("Comparison period", formatMoney(category.change.priorCents), category.change.priorCents),
        cite("Change", formatSignedPercent(category.change.percent), category.change.percent),
        cite("Transactions", String(category.transactionCount), category.transactionCount),
      ],
      comparisonLabel: input.period.comparisonLabel,
      recommendedAction: `Open ${category.category} transactions to see what drove the increase.`,
      drilldown: {
        kind: "transactions",
        filters: {
          category: category.category,
          dateFrom: input.period.range.start,
          dateTo: input.period.range.end,
        },
      },
      actionLabel: "View transactions",
      method: `Compares each category against the comparison period and reports increases over ${formatMoney(MATERIAL_CHANGE_CENTS)} and ${MATERIAL_CHANGE_PERCENT}%.`,
      rank: category.change.deltaCents / 100,
    });
  }

  const uncategorized = input.categories.find((category) => category.category === "Uncategorized");
  if (uncategorized && uncategorized.percentOfTotal >= 10) {
    insights.push({
      id: "uncategorized_spending",
      severity: "watch",
      title: "A meaningful share of spending is uncategorized",
      summary: `${formatMoney(uncategorized.amountCents)} (${formatPercent(uncategorized.percentOfTotal)} of spending) has no category, which limits every other breakdown on this page.`,
      citations: [
        cite("Uncategorized", formatMoney(uncategorized.amountCents), uncategorized.amountCents),
        cite("Share of spending", formatPercent(uncategorized.percentOfTotal), uncategorized.percentOfTotal),
        cite("Transactions", String(uncategorized.transactionCount), uncategorized.transactionCount),
      ],
      comparisonLabel: input.period.label,
      recommendedAction: "Assign categories so spending analysis and budgets reflect reality.",
      drilldown: { kind: "transactions", filters: { quickFilter: "needs_review" } },
      actionLabel: "Categorize transactions",
      method: "Measures spending with no category as a share of total spending in the period.",
      rank: uncategorized.percentOfTotal,
    });
  }

  return insights;
}

// ─── Vendors ──────────────────────────────────────────────────────────────────

function vendorInsights(input: InsightInput): Insight[] {
  const insights: Insight[] = [];
  const top = input.vendors[0];

  if (top && top.percentOfSpend >= VENDOR_CONCENTRATION_PERCENT && input.vendors.length > 2) {
    insights.push({
      id: "vendor_concentration",
      severity: "informational",
      title: `${top.name} accounts for ${formatPercent(top.percentOfSpend)} of spending`,
      summary: `${formatMoney(top.totalSpendCents)} of department spending in this period went to a single vendor across ${formatCount(top.transactionCount, "transaction")}.`,
      citations: [
        cite("Vendor total", formatMoney(top.totalSpendCents), top.totalSpendCents),
        cite("Share of spending", formatPercent(top.percentOfSpend), top.percentOfSpend),
        cite("Transactions", String(top.transactionCount), top.transactionCount),
      ],
      comparisonLabel: input.period.label,
      recommendedAction:
        "Worth knowing when planning purchases or reviewing whether the department should compare pricing.",
      drilldown: { kind: "vendor", vendorKey: top.key },
      actionLabel: "View vendor",
      method: `Reports when one vendor exceeds ${VENDOR_CONCENTRATION_PERCENT}% of spending in the period.`,
      rank: top.percentOfSpend,
    });
  }

  const grown = input.vendors
    .filter((vendor) => vendor.change.hasComparison)
    .filter(
      (vendor) =>
        vendor.change.deltaCents >= MATERIAL_CHANGE_CENTS &&
        (vendor.change.percent ?? 0) >= 50,
    )
    .sort((a, b) => b.change.deltaCents - a.change.deltaCents)[0];

  if (grown) {
    insights.push({
      id: `vendor_increase_${grown.key}`,
      severity: "watch",
      title: `Spending with ${grown.name} has grown sharply`,
      summary: `${formatMoney(grown.totalSpendCents)} this period against ${formatMoney(grown.change.priorCents)} in the comparison period.`,
      citations: [
        cite("This period", formatMoney(grown.totalSpendCents), grown.totalSpendCents),
        cite("Comparison period", formatMoney(grown.change.priorCents), grown.change.priorCents),
        cite("Change", formatSignedPercent(grown.change.percent), grown.change.percent),
      ],
      comparisonLabel: input.period.comparisonLabel,
      recommendedAction: "Check whether the increase reflects planned work or something to question.",
      drilldown: { kind: "vendor", vendorKey: grown.key },
      actionLabel: "View vendor",
      method: `Reports vendors whose spending grew by more than ${formatMoney(MATERIAL_CHANGE_CENTS)} and 50% against the comparison period.`,
      rank: grown.change.deltaCents / 100,
    });
  }

  return insights;
}

// ─── Budgets ──────────────────────────────────────────────────────────────────

function budgetInsights(input: InsightInput): Insight[] {
  const budgets = input.budgets;
  if (!budgets?.hasBudgets) return [];

  const insights: Insight[] = [];

  const over = budgets.lines
    .filter((line) => line.status === "over_budget")
    .sort((a, b) => b.actualCents - b.budgetCents - (a.actualCents - a.budgetCents))
    .slice(0, 2);

  for (const line of over) {
    const overageCents = line.actualCents - line.budgetCents;
    insights.push({
      id: `budget_over_${line.category}`,
      severity: "action_needed",
      title: `${line.category} is over budget`,
      summary: `${formatMoney(line.actualCents)} spent against a ${formatMoney(line.budgetCents)} budget, ${formatMoney(overageCents)} over.`,
      citations: [
        cite("Spent", formatMoney(line.actualCents), line.actualCents),
        cite("Budget", formatMoney(line.budgetCents), line.budgetCents),
        cite("Over by", formatMoney(overageCents), overageCents),
        cite("Consumed", formatPercent(line.percentConsumed), line.percentConsumed),
      ],
      comparisonLabel: `${budgets.fiscalYear} budget year`,
      recommendedAction: "Review the category and decide whether to adjust the budget or the spending.",
      drilldown: { kind: "transactions", filters: { category: line.category } },
      actionLabel: "View transactions",
      method: "Compares recorded spending for the budget year against the amount budgeted for that category.",
      rank: overageCents / 100,
    });
  }

  const approaching = budgets.lines
    .filter((line) => line.status === "approaching")
    .sort((a, b) => (b.percentConsumed ?? 0) - (a.percentConsumed ?? 0))[0];

  if (approaching) {
    insights.push({
      id: `budget_approaching_${approaching.category}`,
      severity: "watch",
      title: `${approaching.category} is approaching its budget`,
      summary: `${formatPercent(approaching.percentConsumed)} of the ${formatMoney(approaching.budgetCents)} budget is used with ${12 - budgets.monthsElapsed} month${12 - budgets.monthsElapsed === 1 ? "" : "s"} left in the year.`,
      citations: [
        cite("Spent", formatMoney(approaching.actualCents), approaching.actualCents),
        cite("Budget", formatMoney(approaching.budgetCents), approaching.budgetCents),
        cite("Remaining", formatMoney(approaching.remainingCents), approaching.remainingCents),
        cite("Consumed", formatPercent(approaching.percentConsumed), approaching.percentConsumed),
      ],
      comparisonLabel: `${budgets.fiscalYear} budget year`,
      recommendedAction: "Plan remaining purchases in this category against what is left.",
      drilldown: { kind: "transactions", filters: { category: approaching.category } },
      actionLabel: "View transactions",
      method:
        "Flags categories consuming their budget faster than the year is progressing, or already above 90% consumed.",
      rank: approaching.percentConsumed ?? 0,
    });
  }

  return insights;
}

// ─── Cash and cards ───────────────────────────────────────────────────────────

function cashInsights(input: InsightInput): Insight[] {
  const insights: Insight[] = [];
  const { cash, cashFlow } = input;

  if (cash.creditCardBalanceCents > 0 && cash.netLiquidCents < 0) {
    insights.push({
      id: "card_exceeds_cash",
      severity: "action_needed",
      title: "Card balances exceed available cash",
      summary: `Outstanding card balances of ${formatMoney(cash.creditCardBalanceCents)} are more than the ${formatMoney(cash.totalCashCents)} currently in cash accounts.`,
      citations: [
        cite("Cash", formatMoney(cash.totalCashCents), cash.totalCashCents),
        cite("Card balances", formatMoney(cash.creditCardBalanceCents), cash.creditCardBalanceCents),
        cite("Net liquid position", formatMoney(cash.netLiquidCents), cash.netLiquidCents),
      ],
      comparisonLabel: null,
      recommendedAction: "Confirm upcoming deposits and plan card payments before new purchases.",
      drilldown: { kind: "accounts" },
      actionLabel: "Review accounts",
      method: "Subtracts total outstanding liability balances from total asset balances.",
      rank: absCents(cash.netLiquidCents) / 100,
    });
  }

  const runway = cashFlow.outlook.runwayStatus;
  if (runway && (runway.level === "risk" || runway.level === "attention")) {
    insights.push({
      id: "cash_runway",
      severity: runway.level === "risk" ? "action_needed" : "watch",
      title: "Cash may not cover the usual monthly outflow for long",
      summary: runway.explanation,
      citations: [
        cite(
          "Current cash",
          formatMoney(cashFlow.outlook.currentBalanceCents),
          cashFlow.outlook.currentBalanceCents,
        ),
        cite(
          "Average monthly spending",
          formatMoney(cashFlow.outlook.averageMonthlyOutflowCents),
          cashFlow.outlook.averageMonthlyOutflowCents,
        ),
        cite("Months of history used", String(cashFlow.outlook.monthsOfHistory), cashFlow.outlook.monthsOfHistory),
      ],
      comparisonLabel: `Last ${cashFlow.outlook.monthsOfHistory} months`,
      recommendedAction: "Review expected income and any large planned purchases. This is an estimate, not a prediction.",
      drilldown: { kind: "accounts" },
      actionLabel: "Review accounts",
      method:
        "Divides current cash by the average monthly outflow over the months with recorded activity. It assumes spending continues at the same pace.",
      rank: 500,
    });
  }

  const negative = input.accounts.filter(
    (row) =>
      row.account.kind === "asset" && row.balanceCents != null && row.balanceCents < 0,
  );
  for (const row of negative.slice(0, 2)) {
    insights.push({
      id: `account_negative_${row.account.id}`,
      severity: "action_needed",
      title: `${row.account.name} shows a negative balance`,
      summary: `Hallix calculates ${formatMoney(row.balanceCents)} in ${row.account.name}, which usually means a missing deposit or an incorrect opening balance.`,
      citations: [
        cite("Account", row.account.name),
        cite("Calculated balance", formatMoney(row.balanceCents), row.balanceCents),
      ],
      comparisonLabel: null,
      recommendedAction: "Check the opening balance and confirm no deposits are missing from the ledger.",
      drilldown: { kind: "accounts" },
      actionLabel: "Review accounts",
      method:
        "Rolls the account's recorded opening balance or last reconciled balance forward through ledger activity.",
      rank: absCents(row.balanceCents ?? 0) / 100,
    });
  }

  const staleCards = input.accounts.filter(
    (row) =>
      row.account.kind === "liability" &&
      row.balanceCents != null &&
      absCents(row.balanceCents) > 0 &&
      (row.account.lastReconciledAt == null ||
        (absDaysBetween(input.period.range.end, row.account.lastReconciledAt.slice(0, 10)) ?? 0) >
          STALE_ACCOUNT_RECONCILIATION_DAYS),
  );

  for (const row of staleCards.slice(0, 1)) {
    insights.push({
      id: `card_unverified_${row.account.id}`,
      severity: "watch",
      title: `${row.account.name} carries a balance that has not been verified recently`,
      summary: `Hallix shows ${formatMoney(absCents(row.balanceCents ?? 0))} outstanding on ${row.account.name} without a recent reconciliation to confirm it.`,
      citations: [
        cite("Card", row.account.name),
        cite("Calculated balance", formatMoney(absCents(row.balanceCents ?? 0)), absCents(row.balanceCents ?? 0)),
        cite("Last reconciled", row.account.lastReconciledAt?.slice(0, 10) ?? "Never"),
      ],
      comparisonLabel: null,
      recommendedAction: "Reconcile the card against its latest statement to confirm the balance and payments.",
      drilldown: { kind: "reconciliation", queue: "unreconciled" },
      actionLabel: "Open reconciliation",
      method: `Flags liability accounts with an outstanding balance and no reconciliation in the last ${STALE_ACCOUNT_RECONCILIATION_DAYS} days.`,
      rank: 200,
    });
  }

  return insights;
}

/**
 * The payload sent for optional rewriting. Only the wording travels; every
 * number stays here and is re-rendered from the deterministic insight.
 */
export function insightNarrationPayload(insights: Insight[]) {
  return insights.map((insight) => ({
    id: insight.id,
    severity: insight.severity,
    title: insight.title,
    summary: insight.summary,
    facts: insight.citations.map((citation) => `${citation.label}: ${citation.value}`),
  }));
}
