/**
 * Budget-versus-actual analytics.
 *
 * Budgets are optional. A department that has not entered any sees an invitation
 * to set them up rather than a wall of empty progress bars.
 *
 * Status deliberately accounts for how far through the year the department is.
 * A category that has used 45% of its budget in June is on track, not a
 * problem, and colouring it red would train people to ignore the colour.
 */

import { parseCents, type Cents } from "../reconciliation/money";
import type { IsoDate } from "../reconciliation/dates";
import { todayIso } from "./date-range";
import { UNCATEGORIZED_LABEL } from "./aggregate";
import { percentOrNull } from "./two-percent";
import type { AnalyticsTransaction, DepartmentBudgetRow, StatusLevel } from "./types";

export type BudgetStatus =
  | "over_budget"
  | "approaching"
  | "on_track"
  | "underused"
  | "no_spending";

export const BUDGET_STATUS_LABELS: Record<BudgetStatus, string> = {
  over_budget: "Over budget",
  approaching: "Approaching budget",
  on_track: "On track",
  underused: "Under planned pace",
  no_spending: "No spending yet",
};

export const BUDGET_STATUS_LEVEL: Record<BudgetStatus, StatusLevel> = {
  over_budget: "risk",
  approaching: "attention",
  on_track: "positive",
  underused: "neutral",
  no_spending: "neutral",
};

export type BudgetLine = {
  category: string;
  budgetCents: Cents;
  actualCents: Cents;
  remainingCents: Cents;
  percentConsumed: number | null;
  /** Straight-line spend projected to year end from the pace so far. */
  projectedYearEndCents: Cents | null;
  projectedOverageCents: Cents | null;
  status: BudgetStatus;
  transactionCount: number;
  priorYearActualCents: Cents | null;
};

export type BudgetSummary = {
  hasBudgets: boolean;
  fiscalYear: number;
  lines: BudgetLine[];
  totalBudgetCents: Cents;
  totalActualCents: Cents;
  totalRemainingCents: Cents;
  overBudgetCount: number;
  approachingCount: number;
  /** Spending in categories with no budget line at all. */
  unbudgetedActualCents: Cents;
  unbudgetedCategoryCount: number;
  monthsElapsed: number;
};

export function normalizeCategoryKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function summarizeBudgets(options: {
  budgets: DepartmentBudgetRow[];
  transactions: AnalyticsTransaction[];
  priorYearTransactions?: AnalyticsTransaction[] | null;
  fiscalYear: number;
  today?: IsoDate;
}): BudgetSummary {
  const today = options.today ?? todayIso();
  const monthsElapsed = monthsElapsedInYear(options.fiscalYear, today);

  const actuals = spendByCategory(options.transactions, options.fiscalYear);
  const priorActuals = options.priorYearTransactions
    ? spendByCategory(options.priorYearTransactions, options.fiscalYear - 1)
    : null;

  const budgeted = new Set<string>();
  const lines: BudgetLine[] = options.budgets
    .filter((budget) => budget.fiscal_year === options.fiscalYear)
    .map((budget) => {
      const key = budget.normalized_category || normalizeCategoryKey(budget.category);
      budgeted.add(key);
      const budgetCents = parseCents(budget.amount) ?? 0;
      const actual = actuals.get(key);
      const actualCents = actual?.amountCents ?? 0;
      const percentConsumed = percentOrNull(actualCents, budgetCents);

      const projectedYearEndCents =
        monthsElapsed === 0
          ? null
          : Math.round((actualCents / monthsElapsed) * 12);

      return {
        category: budget.category,
        budgetCents,
        actualCents,
        remainingCents: budgetCents - actualCents,
        percentConsumed,
        projectedYearEndCents,
        projectedOverageCents:
          projectedYearEndCents == null
            ? null
            : Math.max(0, projectedYearEndCents - budgetCents),
        status: budgetStatus({ budgetCents, actualCents, monthsElapsed }),
        transactionCount: actual?.count ?? 0,
        priorYearActualCents: priorActuals ? (priorActuals.get(key)?.amountCents ?? 0) : null,
      };
    })
    .sort((a, b) => b.actualCents - a.actualCents);

  let unbudgetedActualCents = 0;
  let unbudgetedCategoryCount = 0;
  for (const [key, entry] of actuals) {
    if (budgeted.has(key)) continue;
    unbudgetedActualCents += entry.amountCents;
    unbudgetedCategoryCount += 1;
  }

  const totalBudgetCents = lines.reduce((sum, line) => sum + line.budgetCents, 0);
  const totalActualCents = lines.reduce((sum, line) => sum + line.actualCents, 0);

  return {
    hasBudgets: lines.length > 0,
    fiscalYear: options.fiscalYear,
    lines,
    totalBudgetCents,
    totalActualCents,
    totalRemainingCents: totalBudgetCents - totalActualCents,
    overBudgetCount: lines.filter((line) => line.status === "over_budget").length,
    approachingCount: lines.filter((line) => line.status === "approaching").length,
    unbudgetedActualCents,
    unbudgetedCategoryCount,
    monthsElapsed,
  };
}

/**
 * Judge a budget line against the calendar, not just the total.
 *
 * "Approaching" means spending is running meaningfully ahead of the year's
 * progress, which is the point at which someone can still act on it.
 */
function budgetStatus(input: {
  budgetCents: Cents;
  actualCents: Cents;
  monthsElapsed: number;
}): BudgetStatus {
  if (input.actualCents === 0) return "no_spending";
  if (input.budgetCents <= 0) return "over_budget";
  if (input.actualCents > input.budgetCents) return "over_budget";

  const consumed = (input.actualCents / input.budgetCents) * 100;
  const expected = input.monthsElapsed === 0 ? 0 : (input.monthsElapsed / 12) * 100;

  if (consumed >= 90) return "approaching";
  if (consumed > expected + 15) return "approaching";
  if (input.monthsElapsed >= 6 && consumed < expected - 25) return "underused";
  return "on_track";
}

function spendByCategory(transactions: AnalyticsTransaction[], year: number) {
  const map = new Map<string, { amountCents: Cents; count: number }>();
  const prefix = String(year);
  for (const transaction of transactions) {
    if (!transaction.date?.startsWith(prefix)) continue;
    if (transaction.classification !== "expense" && transaction.classification !== "refund") {
      continue;
    }
    const key = normalizeCategoryKey(transaction.category || UNCATEGORIZED_LABEL);
    const entry = map.get(key) ?? { amountCents: 0, count: 0 };
    if (transaction.classification === "expense") {
      entry.amountCents += transaction.magnitudeCents;
      entry.count += 1;
    } else {
      entry.amountCents -= transaction.magnitudeCents;
    }
    map.set(key, entry);
  }
  return map;
}

function monthsElapsedInYear(year: number, today: IsoDate): number {
  const currentYear = Number(today.slice(0, 4));
  if (currentYear > year) return 12;
  if (currentYear < year) return 0;
  return Number(today.slice(5, 7));
}
