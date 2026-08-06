/**
 * Rollups over normalized transactions.
 *
 * Everything here reads `AnalyticsTransaction` values produced by `classify.ts`
 * and never re-decides what a transaction is. Transfers and credit card
 * payments are already classified out of the operating figures by the time
 * they reach this module, so no rollup can accidentally reintroduce them.
 */

import { absCents, type Cents } from "../reconciliation/money";
import type { IsoDate } from "../reconciliation/dates";
import { monthKey, monthKeysInRange, rangeContains } from "./date-range";
import type {
  AnalyticsTransaction,
  ClassifiedAccount,
  DateRange,
  PeriodChange,
  TransactionClass,
} from "./types";

// ─── Period slicing ───────────────────────────────────────────────────────────

export function transactionsInRange(
  transactions: AnalyticsTransaction[],
  range: DateRange,
): AnalyticsTransaction[] {
  return transactions.filter((transaction) => rangeContains(range, transaction.date));
}

// ─── Headline totals ──────────────────────────────────────────────────────────

export type PeriodTotals = {
  /** Money received, excluding transfers, card payments and refunds. */
  incomeCents: Cents;
  /** Spending after refunds are netted off. */
  expenseCents: Cents;
  /** Spending before refunds, useful when explaining the netting. */
  grossExpenseCents: Cents;
  refundCents: Cents;
  netCents: Cents;
  internalTransferCents: Cents;
  creditCardPaymentCents: Cents;
  transactionCount: number;
  expenseTransactionCount: number;
  uncategorizedExpenseCents: Cents;
  uncategorizedExpenseCount: number;
};

export function totalsFor(transactions: AnalyticsTransaction[]): PeriodTotals {
  let incomeCents = 0;
  let grossExpenseCents = 0;
  let refundCents = 0;
  let internalTransferCents = 0;
  let creditCardPaymentCents = 0;
  let expenseTransactionCount = 0;
  let uncategorizedExpenseCents = 0;
  let uncategorizedExpenseCount = 0;

  for (const transaction of transactions) {
    const amount = transaction.magnitudeCents;
    switch (transaction.classification) {
      case "income":
        incomeCents += amount;
        break;
      case "expense":
        grossExpenseCents += amount;
        expenseTransactionCount += 1;
        if (!transaction.category) {
          uncategorizedExpenseCents += amount;
          uncategorizedExpenseCount += 1;
        }
        break;
      case "refund":
        refundCents += amount;
        break;
      case "internal_transfer":
        internalTransferCents += amount;
        break;
      case "credit_card_payment":
        creditCardPaymentCents += amount;
        break;
    }
  }

  const expenseCents = grossExpenseCents - refundCents;

  return {
    incomeCents,
    expenseCents,
    grossExpenseCents,
    refundCents,
    netCents: incomeCents - expenseCents,
    internalTransferCents,
    creditCardPaymentCents,
    transactionCount: transactions.length,
    expenseTransactionCount,
    uncategorizedExpenseCents,
    uncategorizedExpenseCount,
  };
}

// ─── Comparisons ──────────────────────────────────────────────────────────────

/**
 * Compare a figure against its prior-period equivalent.
 *
 * When the prior period is zero the percentage is null rather than infinity or
 * an arbitrary 100%. "Up from nothing" is a real observation, but it is not a
 * percentage, and rendering one there misleads.
 */
export function changeBetween(
  currentCents: Cents,
  priorCents: Cents | null,
): PeriodChange {
  if (priorCents == null) {
    return {
      currentCents,
      priorCents: 0,
      deltaCents: 0,
      percent: null,
      hasComparison: false,
    };
  }

  const deltaCents = currentCents - priorCents;
  const percent = priorCents === 0 ? null : (deltaCents / Math.abs(priorCents)) * 100;

  return { currentCents, priorCents, deltaCents, percent, hasComparison: true };
}

// ─── Categories ───────────────────────────────────────────────────────────────

export const UNCATEGORIZED_LABEL = "Uncategorized";

export type CategoryTotal = {
  category: string;
  amountCents: Cents;
  transactionCount: number;
  percentOfTotal: number;
  missingReceiptCount: number;
  change: PeriodChange;
};

export function categoryTotals(options: {
  current: AnalyticsTransaction[];
  prior?: AnalyticsTransaction[] | null;
  classification?: TransactionClass;
}): CategoryTotal[] {
  const classification = options.classification ?? "expense";
  const currentMap = groupByCategory(options.current, classification);
  const priorMap = options.prior
    ? groupByCategory(options.prior, classification)
    : null;

  const grandTotal = [...currentMap.values()].reduce((sum, entry) => sum + entry.amountCents, 0);

  const rows = [...currentMap.entries()].map(([category, entry]) => ({
    category,
    amountCents: entry.amountCents,
    transactionCount: entry.transactionCount,
    missingReceiptCount: entry.missingReceiptCount,
    percentOfTotal: grandTotal === 0 ? 0 : (entry.amountCents / grandTotal) * 100,
    change: changeBetween(
      entry.amountCents,
      priorMap ? (priorMap.get(category)?.amountCents ?? 0) : null,
    ),
  }));

  // Ties are broken by name so the chart and table do not reorder themselves
  // between renders when two categories happen to match.
  return rows.sort(
    (a, b) => b.amountCents - a.amountCents || a.category.localeCompare(b.category),
  );
}

function groupByCategory(
  transactions: AnalyticsTransaction[],
  classification: TransactionClass,
) {
  const map = new Map<
    string,
    { amountCents: Cents; transactionCount: number; missingReceiptCount: number }
  >();
  for (const transaction of transactions) {
    if (transaction.classification !== classification) continue;
    const key = transaction.category || UNCATEGORIZED_LABEL;
    const entry = map.get(key) ?? {
      amountCents: 0,
      transactionCount: 0,
      missingReceiptCount: 0,
    };
    entry.amountCents += transaction.magnitudeCents;
    entry.transactionCount += 1;
    if (!transaction.hasReceipt) entry.missingReceiptCount += 1;
    map.set(key, entry);
  }
  return map;
}

/**
 * Collapse the long tail into a single "Other" slice so a donut stays readable.
 * Slices below `minPercent` are merged, but only when merging removes more than
 * one slice — a lone small slice is clearer under its own name.
 */
export function collapseSmallCategories(
  rows: CategoryTotal[],
  options: { maxSlices?: number; minPercent?: number } = {},
): CategoryTotal[] {
  const maxSlices = options.maxSlices ?? 8;
  const minPercent = options.minPercent ?? 2;

  const keep: CategoryTotal[] = [];
  const merge: CategoryTotal[] = [];
  rows.forEach((row, index) => {
    if (index < maxSlices && row.percentOfTotal >= minPercent) keep.push(row);
    else merge.push(row);
  });

  if (merge.length <= 1) return rows;

  const otherAmount = merge.reduce((sum, row) => sum + row.amountCents, 0);
  const otherCount = merge.reduce((sum, row) => sum + row.transactionCount, 0);
  const otherMissing = merge.reduce((sum, row) => sum + row.missingReceiptCount, 0);
  const otherPercent = merge.reduce((sum, row) => sum + row.percentOfTotal, 0);

  return [
    ...keep,
    {
      category: "Other",
      amountCents: otherAmount,
      transactionCount: otherCount,
      missingReceiptCount: otherMissing,
      percentOfTotal: otherPercent,
      change: changeBetween(otherAmount, null),
    },
  ];
}

/** Categories that moved most between periods, largest absolute change first. */
export function largestCategoryChanges(
  rows: CategoryTotal[],
  direction: "increase" | "decrease",
  limit = 5,
): CategoryTotal[] {
  return rows
    .filter((row) => row.change.hasComparison)
    .filter((row) =>
      direction === "increase" ? row.change.deltaCents > 0 : row.change.deltaCents < 0,
    )
    .sort((a, b) =>
      direction === "increase"
        ? b.change.deltaCents - a.change.deltaCents
        : a.change.deltaCents - b.change.deltaCents,
    )
    .slice(0, limit);
}

// ─── Vendors ──────────────────────────────────────────────────────────────────

export type VendorTotal = {
  key: string;
  name: string;
  totalSpendCents: Cents;
  transactionCount: number;
  averageCents: Cents;
  largestCents: Cents;
  percentOfSpend: number;
  topCategories: Array<{ category: string; amountCents: Cents }>;
  topAccountName: string | null;
  firstActivity: IsoDate | null;
  lastActivity: IsoDate | null;
  missingReceiptCount: number;
  unreconciledCount: number;
  change: PeriodChange;
};

/**
 * The identity used to group a vendor's transactions. Exported so anything
 * matching transactions back to a vendor row uses the same rule rather than a
 * second, subtly different one.
 */
export function vendorKeyFor(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase();
}

export function vendorTotals(options: {
  current: AnalyticsTransaction[];
  prior?: AnalyticsTransaction[] | null;
}): VendorTotal[] {
  const currentMap = groupByVendor(options.current);
  const priorMap = options.prior ? groupByVendor(options.prior) : null;

  const grandTotal = [...currentMap.values()].reduce((sum, entry) => sum + entry.total, 0);

  const rows: VendorTotal[] = [...currentMap.entries()].map(([key, entry]) => {
    const topCategories = [...entry.categories.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([category, amountCents]) => ({ category, amountCents }));

    let topAccountName: string | null = null;
    let topAccountAmount = -1;
    for (const [account, amount] of entry.accounts) {
      if (amount > topAccountAmount) {
        topAccountAmount = amount;
        topAccountName = account;
      }
    }

    return {
      key,
      name: entry.name,
      totalSpendCents: entry.total,
      transactionCount: entry.count,
      averageCents: entry.count === 0 ? 0 : Math.round(entry.total / entry.count),
      largestCents: entry.largest,
      percentOfSpend: grandTotal === 0 ? 0 : (entry.total / grandTotal) * 100,
      topCategories,
      topAccountName,
      firstActivity: entry.first,
      lastActivity: entry.last,
      missingReceiptCount: entry.missingReceipts,
      unreconciledCount: entry.unreconciled,
      change: changeBetween(entry.total, priorMap ? (priorMap.get(key)?.total ?? 0) : null),
    };
  });

  return rows.sort(
    (a, b) => b.totalSpendCents - a.totalSpendCents || a.name.localeCompare(b.name),
  );
}

function groupByVendor(transactions: AnalyticsTransaction[]) {
  const map = new Map<
    string,
    {
      name: string;
      total: Cents;
      count: number;
      largest: Cents;
      first: IsoDate | null;
      last: IsoDate | null;
      categories: Map<string, Cents>;
      accounts: Map<string, Cents>;
      missingReceipts: number;
      unreconciled: number;
    }
  >();

  for (const transaction of transactions) {
    if (transaction.classification !== "expense") continue;
    const name = transaction.vendor?.trim();
    if (!name) continue;
    const key = vendorKeyFor(name);

    const entry = map.get(key) ?? {
      name,
      total: 0,
      count: 0,
      largest: 0,
      first: null,
      last: null,
      categories: new Map<string, Cents>(),
      accounts: new Map<string, Cents>(),
      missingReceipts: 0,
      unreconciled: 0,
    };

    entry.total += transaction.magnitudeCents;
    entry.count += 1;
    if (transaction.magnitudeCents > entry.largest) entry.largest = transaction.magnitudeCents;
    if (transaction.date) {
      if (!entry.first || transaction.date < entry.first) entry.first = transaction.date;
      if (!entry.last || transaction.date > entry.last) entry.last = transaction.date;
    }
    const category = transaction.category || UNCATEGORIZED_LABEL;
    entry.categories.set(category, (entry.categories.get(category) ?? 0) + transaction.magnitudeCents);
    if (transaction.accountName) {
      entry.accounts.set(
        transaction.accountName,
        (entry.accounts.get(transaction.accountName) ?? 0) + transaction.magnitudeCents,
      );
    }
    if (!transaction.hasReceipt) entry.missingReceipts += 1;
    if (!transaction.isReconciled) entry.unreconciled += 1;

    map.set(key, entry);
  }

  return map;
}

// ─── Trends ───────────────────────────────────────────────────────────────────

export type MonthlyPoint = {
  monthKey: string;
  incomeCents: Cents;
  expenseCents: Cents;
  netCents: Cents;
};

export function monthlyTrend(
  transactions: AnalyticsTransaction[],
  range: DateRange,
): MonthlyPoint[] {
  const buckets = new Map<string, { income: Cents; expense: Cents }>();
  for (const key of monthKeysInRange(range)) {
    buckets.set(key, { income: 0, expense: 0 });
  }

  for (const transaction of transactions) {
    if (!transaction.date) continue;
    const key = monthKey(transaction.date);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    if (transaction.classification === "income") bucket.income += transaction.magnitudeCents;
    else if (transaction.classification === "expense") bucket.expense += transaction.magnitudeCents;
    else if (transaction.classification === "refund") bucket.expense -= transaction.magnitudeCents;
  }

  return [...buckets.entries()].map(([key, bucket]) => ({
    monthKey: key,
    incomeCents: bucket.income,
    expenseCents: bucket.expense,
    netCents: bucket.income - bucket.expense,
  }));
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

export type AccountActivity = {
  account: ClassifiedAccount;
  /** Best available current balance, or null when nothing supports one. */
  balanceCents: Cents | null;
  balanceSource: "reconciled_statement" | "opening_plus_activity" | "none";
  depositsCents: Cents;
  withdrawalsCents: Cents;
  transactionCount: number;
  unreconciledCount: number;
  missingReceiptCount: number;
  pendingImportedCount: number;
  lastActivity: IsoDate | null;
};

/**
 * Balance is taken from the last reconciled statement when one exists, because
 * that figure was checked against the bank. Otherwise it is the recorded
 * opening balance rolled forward by ledger activity. When there is neither, the
 * balance is null and the UI says so rather than showing a confident zero.
 */
export function accountActivity(options: {
  accounts: ClassifiedAccount[];
  allTransactions: AnalyticsTransaction[];
  rangeTransactions: AnalyticsTransaction[];
  openingBalancesByAccountId?: Map<string, { cents: Cents; date: IsoDate | null }>;
  lastReconciledByAccountId?: Map<string, { cents: Cents; date: IsoDate | null }>;
  pendingCountByAccountId?: Map<string, number>;
}): AccountActivity[] {
  return options.accounts.map((account) => {
    const rangeRows = options.rangeTransactions.filter((row) => row.accountId === account.id);
    const allRows = options.allTransactions.filter((row) => row.accountId === account.id);

    let depositsCents = 0;
    let withdrawalsCents = 0;
    let unreconciledCount = 0;
    let missingReceiptCount = 0;
    let lastActivity: IsoDate | null = null;

    for (const row of rangeRows) {
      if (row.signedCents != null && row.signedCents > 0) depositsCents += row.signedCents;
      else withdrawalsCents += absCents(row.signedCents ?? 0);
      if (!row.isReconciled) unreconciledCount += 1;
      if (row.classification === "expense" && !row.hasReceipt) missingReceiptCount += 1;
      if (row.date && (!lastActivity || row.date > lastActivity)) lastActivity = row.date;
    }

    const reconciled = options.lastReconciledByAccountId?.get(account.id);
    const opening = options.openingBalancesByAccountId?.get(account.id);

    let balanceCents: Cents | null = null;
    let balanceSource: AccountActivity["balanceSource"] = "none";

    if (reconciled) {
      balanceCents = reconciled.cents + netSince(allRows, reconciled.date);
      balanceSource = "reconciled_statement";
    } else if (opening) {
      balanceCents = opening.cents + netSince(allRows, opening.date);
      balanceSource = "opening_plus_activity";
    }

    return {
      account,
      balanceCents,
      balanceSource,
      depositsCents,
      withdrawalsCents,
      transactionCount: rangeRows.length,
      unreconciledCount,
      missingReceiptCount,
      pendingImportedCount: options.pendingCountByAccountId?.get(account.id) ?? 0,
      lastActivity,
    };
  });
}

/** Net ledger movement strictly after a given date. */
function netSince(rows: AnalyticsTransaction[], after: IsoDate | null): Cents {
  let total = 0;
  for (const row of rows) {
    if (row.signedCents == null) continue;
    if (after && (!row.date || row.date <= after)) continue;
    total += row.signedCents;
  }
  return total;
}

export type CashPosition = {
  totalCashCents: Cents;
  operatingCashCents: Cents;
  designatedCashCents: Cents;
  creditCardBalanceCents: Cents;
  netLiquidCents: Cents;
  /** True when at least one account has no balance evidence at all. */
  hasIncompleteBalances: boolean;
  unclassifiedAccountCount: number;
};

export function cashPosition(activity: AccountActivity[]): CashPosition {
  let totalCashCents = 0;
  let operatingCashCents = 0;
  let designatedCashCents = 0;
  let creditCardBalanceCents = 0;
  let hasIncompleteBalances = false;
  let unclassifiedAccountCount = 0;

  for (const row of activity) {
    if (row.account.kind === "unclassified") unclassifiedAccountCount += 1;
    if (row.balanceCents == null) {
      hasIncompleteBalances = true;
      continue;
    }
    if (row.account.kind === "liability") {
      // Card balances are stored as what is owed; show them as a positive debt.
      creditCardBalanceCents += absCents(row.balanceCents);
      continue;
    }
    if (row.account.kind === "asset") {
      totalCashCents += row.balanceCents;
      if (row.account.fund === "operating" || row.account.fund === "unspecified") {
        operatingCashCents += row.balanceCents;
      } else {
        designatedCashCents += row.balanceCents;
      }
    }
  }

  return {
    totalCashCents,
    operatingCashCents,
    designatedCashCents,
    creditCardBalanceCents,
    netLiquidCents: totalCashCents - creditCardBalanceCents,
    hasIncompleteBalances,
    unclassifiedAccountCount,
  };
}

// ─── Top transactions ─────────────────────────────────────────────────────────

export function largestTransactions(
  transactions: AnalyticsTransaction[],
  limit = 10,
): AnalyticsTransaction[] {
  return transactions
    .filter((transaction) => transaction.classification === "expense")
    .sort((a, b) => b.magnitudeCents - a.magnitudeCents)
    .slice(0, limit);
}
