/**
 * The single composition point for the Analytics dashboard.
 *
 * Components render what this returns. They never re-derive a total, so there
 * is exactly one definition of income, expense, transfer, reconciliation and
 * 2% utilization in the product, and the tests that cover this file cover
 * everything the page shows.
 */

import { absCents, parseCents, type Cents } from "../reconciliation/money";
import { isIsoDate, type IsoDate } from "../reconciliation/dates";
import {
  accountActivity,
  cashPosition,
  categoryTotals,
  changeBetween,
  collapseSmallCategories,
  largestCategoryChanges,
  largestTransactions,
  monthlyTrend,
  totalsFor,
  transactionsInRange,
  vendorKeyFor,
  vendorTotals,
  type AccountActivity,
  type CashPosition,
  type CategoryTotal,
  type MonthlyPoint,
  type PeriodTotals,
  type VendorTotal,
} from "./aggregate";
import { classifyAccounts, normalizeAccountName } from "./accounts";
import { normalizeLedger, type ImportedActivity } from "./classify";
import { summarizeBudgets, type BudgetSummary } from "./budgets";
import { summarizeCashFlow, type CashFlowSummary } from "./cash-flow";
import { documentationMetrics, type DocumentationMetrics } from "./documentation";
import { assessDepartmentHealth, type DepartmentHealth } from "./health";
import { generateInsights, type Insight } from "./insights";
import { todayIso } from "./date-range";
import {
  carryoverForYear,
  summarizeTwoPercent,
  twoPercentByCategory,
  twoPercentMonthlySpend,
  type TwoPercentCategoryRow,
  type TwoPercentSummary,
} from "./two-percent";
import type {
  AnalyticsBankAccountRow,
  AnalyticsExpenseRow,
  AnalyticsExternalAccountRow,
  AnalyticsExternalTransactionRow,
  AnalyticsOpeningBalanceRow,
  AnalyticsVendorRow,
  AnalyticsPeriod,
  AnalyticsTransaction,
  ClassifiedAccount,
  DepartmentAnalyticsSettings,
  DepartmentBudgetRow,
  PeriodChange,
} from "./types";

export type AnalyticsFilters = {
  /** Empty means every account. */
  accountIds: string[];
  /** Empty means every category. */
  categories: string[];
};

export const EMPTY_FILTERS: AnalyticsFilters = { accountIds: [], categories: [] };

export type AnalyticsSourceData = {
  expenses: AnalyticsExpenseRow[];
  externalTransactions: AnalyticsExternalTransactionRow[];
  bankAccounts: AnalyticsBankAccountRow[];
  externalAccounts: AnalyticsExternalAccountRow[];
  openingBalances: AnalyticsOpeningBalanceRow[];
  budgets: DepartmentBudgetRow[];
  knownVendors: AnalyticsVendorRow[];
};

export const EMPTY_SOURCE_DATA: AnalyticsSourceData = {
  expenses: [],
  externalTransactions: [],
  bankAccounts: [],
  externalAccounts: [],
  openingBalances: [],
  budgets: [],
  knownVendors: [],
};

export type AnalyticsResult = {
  period: AnalyticsPeriod;
  asOf: IsoDate;

  accounts: ClassifiedAccount[];
  accountActivity: AccountActivity[];
  cash: CashPosition;

  /** Every transaction in the fetched window, after filters. */
  allTransactions: AnalyticsTransaction[];
  currentTransactions: AnalyticsTransaction[];
  priorTransactions: AnalyticsTransaction[] | null;

  totals: PeriodTotals;
  priorTotals: PeriodTotals | null;
  incomeChange: PeriodChange;
  expenseChange: PeriodChange;

  categories: CategoryTotal[];
  categoriesForChart: CategoryTotal[];
  categoryIncreases: CategoryTotal[];
  categoryDecreases: CategoryTotal[];
  topTransactions: AnalyticsTransaction[];
  monthly: MonthlyPoint[];

  vendors: VendorTotal[];
  /**
   * Vendors the department has on record that had no spending in this period.
   * Carried through so a vendor added during onboarding is still visible, which
   * is what the standalone Vendors page showed.
   */
  vendorsWithoutActivity: Array<{ name: string; defaultCategory: string | null }>;

  twoPercent: TwoPercentSummary | null;
  twoPercentCategories: TwoPercentCategoryRow[];
  twoPercentMonthly: Array<{ monthKey: string; amountCents: Cents }>;

  budgets: BudgetSummary;
  cashFlow: CashFlowSummary;
  documentation: DocumentationMetrics;
  priorDocumentation: DocumentationMetrics | null;
  health: DepartmentHealth;
  insights: Insight[];

  imported: ImportedActivity;
  pendingImportedCents: Cents;

  /** True when the department has recorded nothing at all yet. */
  isEmpty: boolean;
  hasAccounts: boolean;
};

export function runAnalytics(options: {
  data: AnalyticsSourceData;
  period: AnalyticsPeriod;
  settings: DepartmentAnalyticsSettings;
  filters?: AnalyticsFilters;
  today?: IsoDate;
}): AnalyticsResult {
  const today = options.today ?? todayIso();
  const filters = options.filters ?? EMPTY_FILTERS;
  const { data, period, settings } = options;

  const accounts = classifyAccounts({
    bankAccounts: data.bankAccounts,
    externalAccounts: data.externalAccounts,
    openingBalances: data.openingBalances,
  });

  const { transactions, imported } = normalizeLedger({
    expenses: data.expenses,
    externalTransactions: data.externalTransactions,
    accounts,
  });

  const allTransactions = applyFilters(transactions, filters);
  const currentTransactions = transactionsInRange(allTransactions, period.range);
  const priorTransactions = period.comparison
    ? transactionsInRange(allTransactions, period.comparison)
    : null;

  // ── Accounts and cash ──────────────────────────────────────────────────────
  const openingAnchors = openingBalanceAnchors(data.openingBalances, accounts);
  const reconciledAnchors = reconciledAnchors_(data.bankAccounts);
  const balanceAnchors = mergeAnchors(reconciledAnchors, openingAnchors);
  const pendingCountByAccountId = pendingCountsByAccount(imported, data.externalAccounts, accounts);

  const activity = accountActivity({
    accounts,
    allTransactions,
    rangeTransactions: currentTransactions,
    openingBalancesByAccountId: openingAnchors,
    lastReconciledByAccountId: reconciledAnchors,
    pendingCountByAccountId,
  });
  const cash = cashPosition(activity);

  // ── Totals and comparisons ─────────────────────────────────────────────────
  const totals = totalsFor(currentTransactions);
  const priorTotals = priorTransactions ? totalsFor(priorTransactions) : null;

  const categories = categoryTotals({
    current: currentTransactions,
    prior: priorTransactions,
  });

  const vendors = vendorTotals({
    current: currentTransactions,
    prior: priorTransactions,
  });

  const activeVendorKeys = new Set(vendors.map((vendor) => vendor.key));
  const vendorsWithoutActivity = data.knownVendors
    .filter((vendor) => !activeVendorKeys.has(vendorKeyFor(vendor.normalized_name || vendor.name)))
    .map((vendor) => ({ name: vendor.name, defaultCategory: vendor.default_category }));

  // ── 2% fund ────────────────────────────────────────────────────────────────
  const reportYear = Number(period.range.end.slice(0, 4));
  const hasTwoPercentAccount = accounts.some((account) => account.isTwoPercent);

  const twoPercent = hasTwoPercentAccount
    ? summarizeTwoPercent({
        transactions: allTransactions,
        accounts,
        reportYear,
        targetPercent: settings.two_percent_target_percent,
        basis: settings.two_percent_basis,
        carryoverCents: carryoverForYear({
          accounts,
          transactions: allTransactions,
          reportYear,
          anchorsByAccountId: balanceAnchors,
        }),
        pendingCents: twoPercentPendingCents(imported, data.externalAccounts, accounts),
        lastReconciledAt: latestTwoPercentReconciliation(accounts),
        today,
      })
    : null;

  const twoPercentCategories = hasTwoPercentAccount
    ? twoPercentByCategory({
        current: allTransactions,
        prior: allTransactions,
        reportYear,
        priorYear: reportYear - 1,
      })
    : [];

  // ── Budgets, cash flow, documentation ──────────────────────────────────────
  const budgets = summarizeBudgets({
    budgets: data.budgets,
    transactions: allTransactions,
    priorYearTransactions: allTransactions,
    fiscalYear: reportYear,
    today,
  });

  const cashFlow = summarizeCashFlow({
    transactions: allTransactions,
    currentBalanceCents: cash.hasIncompleteBalances && cash.totalCashCents === 0 ? null : cash.totalCashCents,
    today,
  });

  const documentation = documentationMetrics({
    transactions: currentTransactions,
    accounts,
    today,
  });
  const priorDocumentation = priorTransactions
    ? documentationMetrics({ transactions: priorTransactions, accounts, today })
    : null;

  const negativeAccountCount = activity.filter(
    (row) => row.account.kind === "asset" && row.balanceCents != null && row.balanceCents < 0,
  ).length;

  const health = assessDepartmentHealth({
    documentation,
    cash,
    twoPercent,
    budgets,
    transactionCount: currentTransactions.length,
    negativeAccountCount,
  });

  const insights = generateInsights({
    period,
    documentation,
    priorDocumentation,
    categories,
    vendors,
    accounts: activity,
    cash,
    cashFlow,
    twoPercent,
    budgets,
  });

  return {
    period,
    asOf: today,
    accounts,
    accountActivity: activity,
    cash,
    allTransactions,
    currentTransactions,
    priorTransactions,
    totals,
    priorTotals,
    incomeChange: changeBetween(totals.incomeCents, priorTotals?.incomeCents ?? null),
    expenseChange: changeBetween(totals.expenseCents, priorTotals?.expenseCents ?? null),
    categories,
    categoriesForChart: collapseSmallCategories(categories),
    categoryIncreases: largestCategoryChanges(categories, "increase"),
    categoryDecreases: largestCategoryChanges(categories, "decrease"),
    topTransactions: largestTransactions(currentTransactions),
    monthly: monthlyTrend(currentTransactions, period.range),
    vendors,
    vendorsWithoutActivity,
    twoPercent,
    twoPercentCategories,
    twoPercentMonthly: hasTwoPercentAccount
      ? twoPercentMonthlySpend(allTransactions, reportYear)
      : [],
    budgets,
    cashFlow,
    documentation,
    priorDocumentation,
    health,
    insights,
    imported,
    pendingImportedCents: pendingCents(imported),
    isEmpty: data.expenses.length === 0 && data.bankAccounts.length === 0,
    hasAccounts: data.bankAccounts.length > 0,
  };
}

// ─── Filters ──────────────────────────────────────────────────────────────────

function applyFilters(
  transactions: AnalyticsTransaction[],
  filters: AnalyticsFilters,
): AnalyticsTransaction[] {
  const accountIds = new Set(filters.accountIds);
  const categories = new Set(filters.categories.map((value) => value.toLowerCase()));
  if (!accountIds.size && !categories.size) return transactions;

  return transactions.filter((transaction) => {
    if (accountIds.size && (!transaction.accountId || !accountIds.has(transaction.accountId))) {
      return false;
    }
    if (categories.size && !categories.has((transaction.category ?? "").toLowerCase())) {
      return false;
    }
    return true;
  });
}

// ─── Balance anchors ──────────────────────────────────────────────────────────

type BalanceAnchor = { cents: Cents; date: IsoDate | null };

function openingBalanceAnchors(
  rows: AnalyticsOpeningBalanceRow[],
  accounts: ClassifiedAccount[],
): Map<string, BalanceAnchor> {
  const byName = new Map<string, ClassifiedAccount>();
  for (const account of accounts) byName.set(account.normalizedName, account);

  const map = new Map<string, BalanceAnchor>();
  for (const row of rows) {
    const account =
      (row.account_id ? accounts.find((entry) => entry.id === row.account_id) : undefined) ??
      byName.get(normalizeAccountName(row.account_name));
    if (!account) continue;

    const cents = parseCents(row.beginning_balance);
    if (cents == null) continue;
    const date = (row.balance_date ?? "").slice(0, 10);

    // Keep the earliest anchor so ledger activity is not counted twice.
    const existing = map.get(account.id);
    if (existing && existing.date && date && existing.date <= date) continue;
    map.set(account.id, { cents, date: isIsoDate(date) ? date : null });
  }
  return map;
}

function reconciledAnchors_(rows: AnalyticsBankAccountRow[]): Map<string, BalanceAnchor> {
  const map = new Map<string, BalanceAnchor>();
  for (const row of rows) {
    const cents = parseCents(row.last_reconciled_ending_balance);
    if (cents == null) continue;
    const date = (row.last_reconciled_at ?? "").slice(0, 10);
    map.set(row.id, { cents, date: isIsoDate(date) ? date : null });
  }
  return map;
}

/** A reconciled statement balance beats an onboarding figure when both exist. */
function mergeAnchors(
  preferred: Map<string, BalanceAnchor>,
  fallback: Map<string, BalanceAnchor>,
): Map<string, BalanceAnchor> {
  const merged = new Map(fallback);
  for (const [key, value] of preferred) merged.set(key, value);
  return merged;
}

// ─── Imported activity helpers ────────────────────────────────────────────────

function externalToBankAccount(
  externalAccounts: AnalyticsExternalAccountRow[],
  accounts: ClassifiedAccount[],
): Map<string, string> {
  const byName = new Map<string, ClassifiedAccount>();
  const byMask = new Map<string, ClassifiedAccount>();
  for (const account of accounts) {
    byName.set(account.normalizedName, account);
    const mask = (account.mask ?? "").trim();
    if (mask) byMask.set(mask, account);
  }

  const map = new Map<string, string>();
  for (const external of externalAccounts) {
    const match =
      byName.get(normalizeAccountName(external.name)) ??
      (external.mask ? byMask.get(external.mask.trim()) : undefined);
    if (match) map.set(external.id, match.id);
  }
  return map;
}

function pendingCountsByAccount(
  imported: ImportedActivity,
  externalAccounts: AnalyticsExternalAccountRow[],
  accounts: ClassifiedAccount[],
): Map<string, number> {
  const link = externalToBankAccount(externalAccounts, accounts);
  const counts = new Map<string, number>();
  for (const row of imported.pending) {
    const bankAccountId = row.external_account_id ? link.get(row.external_account_id) : undefined;
    if (!bankAccountId) continue;
    counts.set(bankAccountId, (counts.get(bankAccountId) ?? 0) + 1);
  }
  return counts;
}

function pendingCents(imported: ImportedActivity): Cents {
  let total = 0;
  for (const row of imported.pending) {
    const cents = parseCents(row.amount);
    if (cents != null) total += absCents(cents);
  }
  return total;
}

function twoPercentPendingCents(
  imported: ImportedActivity,
  externalAccounts: AnalyticsExternalAccountRow[],
  accounts: ClassifiedAccount[],
): Cents {
  const link = externalToBankAccount(externalAccounts, accounts);
  const twoPercentIds = new Set(
    accounts.filter((account) => account.isTwoPercent).map((account) => account.id),
  );

  let total = 0;
  for (const row of imported.pending) {
    const bankAccountId = row.external_account_id ? link.get(row.external_account_id) : undefined;
    if (!bankAccountId || !twoPercentIds.has(bankAccountId)) continue;
    const cents = parseCents(row.amount);
    if (cents != null) total += absCents(cents);
  }
  return total;
}

function latestTwoPercentReconciliation(accounts: ClassifiedAccount[]): string | null {
  let latest: string | null = null;
  for (const account of accounts) {
    if (!account.isTwoPercent || !account.lastReconciledAt) continue;
    if (!latest || account.lastReconciledAt > latest) latest = account.lastReconciledAt;
  }
  return latest;
}

export const DEFAULT_ANALYTICS_SETTINGS: Omit<DepartmentAnalyticsSettings, "department_id"> = {
  two_percent_target_percent: 80,
  two_percent_basis: "total_available",
  fiscal_year_start_month: 1,
};
