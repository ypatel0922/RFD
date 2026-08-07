/**
 * Shared types for the Analytics dashboard.
 *
 * Every monetary value in this layer is an integer number of cents, using the
 * same `Cents` type and parsing rules as the reconciliation feature, so a
 * dashboard total and a reconciliation total can never disagree by a rounding
 * fraction.
 *
 * Sign convention matches `lib/reconciliation/ledger.ts`: a positive amount is
 * money coming in, a negative amount is money going out. That is the bank's
 * sense, not the raw `expenses.total_amount` sense (where a spend is stored as
 * a positive number).
 */

import type { Cents } from "../reconciliation/money";
import type { IsoDate } from "../reconciliation/dates";

// ─── Source rows ──────────────────────────────────────────────────────────────

/** The `expenses` columns analytics reads. Selected explicitly, never `*`. */
export type AnalyticsExpenseRow = {
  id: string;
  transaction_date: string | null;
  created_at: string | null;
  total_amount: string | number | null;
  category: string | null;
  payee: string | null;
  merchant_name: string | null;
  description: string | null;
  fund: string | null;
  payment_reference: string | null;
  payment_method: string | null;
  bank_account_name: string | null;
  receipt_path: string | null;
  original_filename: string | null;
  extraction_status: string | null;
  extraction_notes: string | null;
  reconciliation_status: string | null;
  reconciled_at: string | null;
  reconciliation_candidate: boolean | null;
  uses_two_percent_funds: boolean | null;
  two_percent_review_status: string | null;
};

/** The `external_transactions` columns analytics reads (Plaid-imported rows). */
export type AnalyticsExternalTransactionRow = {
  id: string;
  external_account_id: string | null;
  posted_date: string | null;
  description: string | null;
  amount: string | number | null;
  pending: boolean | null;
  expense_id: string | null;
  match_status: string | null;
};

/** The `bank_accounts` columns analytics reads. */
export type AnalyticsBankAccountRow = {
  id: string;
  name: string;
  institution_name: string | null;
  account_mask: string | null;
  account_type: string | null;
  fund_type: string | null;
  is_two_percent_account: boolean;
  is_default: boolean;
  last_reconciled_at: string | null;
  last_reconciled_ending_balance: string | number | null;
};

/** A Plaid-linked account, used as a fallback signal for account kind. */
export type AnalyticsExternalAccountRow = {
  id: string;
  name: string;
  mask: string | null;
  type: string | null;
  subtype: string | null;
};

/** An opening balance recorded during onboarding. */
export type AnalyticsOpeningBalanceRow = {
  account_id: string | null;
  account_name: string;
  account_type: string | null;
  beginning_balance: string | number | null;
  balance_date: string | null;
};

/** A department's saved budget for one category in one fiscal year. */
export type DepartmentBudgetRow = {
  id: string;
  department_id: string;
  fiscal_year: number;
  category: string;
  normalized_category: string;
  amount: string | number | null;
  notes: string | null;
};

/**
 * A vendor the department has on record, whether or not it has been paid yet.
 *
 * Read so vendor analytics can still list a vendor added during onboarding that
 * has no transactions, which is what the standalone Vendors page did.
 */
export type AnalyticsVendorRow = {
  id: string;
  name: string;
  normalized_name: string;
  default_category: string | null;
};

/** Department-chosen analytics configuration. */
export type DepartmentAnalyticsSettings = {
  department_id: string;
  two_percent_target_percent: number;
  two_percent_basis: TwoPercentBasis;
  fiscal_year_start_month: number;
};

/**
 * Which denominator a 2% utilization percentage is measured against. These are
 * never mixed without being labelled, because they answer different questions.
 */
export type TwoPercentBasis = "total_available" | "current_year_receipts";

// ─── Accounts ─────────────────────────────────────────────────────────────────

/**
 * Whether an account holds the department's money or represents money the
 * department owes. `unclassified` means nobody has told Hallix yet — it is
 * never guessed from the account's name.
 */
export type AccountKind = "asset" | "liability" | "unclassified";

/** Where an account's kind was determined from, shown in the UI for trust. */
export type AccountKindSource = "bank_account_type" | "opening_balance" | "plaid" | "unknown";

export type FundDesignation =
  | "two_percent"
  | "operating"
  | "capital_reserve"
  | "grant"
  | "fundraiser"
  | "restricted"
  | "unspecified";

export type ClassifiedAccount = {
  id: string;
  name: string;
  normalizedName: string;
  institutionName: string | null;
  mask: string | null;
  kind: AccountKind;
  kindSource: AccountKindSource;
  /** The raw type string that produced `kind`, for display. */
  kindLabel: string | null;
  fund: FundDesignation;
  isTwoPercent: boolean;
  isDefault: boolean;
  lastReconciledAt: string | null;
};

// ─── Transactions ─────────────────────────────────────────────────────────────

/**
 * How a transaction affects department totals.
 *
 * `internal_transfer` and `credit_card_payment` are movements of money the
 * department already had. Counting either as income or expense would overstate
 * both sides of the ledger, so both are excluded from those totals and
 * reported separately.
 *
 * `refund` is money coming back from a vendor. It reduces expenses rather than
 * adding to income, so a refunded purchase nets to zero.
 */
export type TransactionClass =
  | "income"
  | "expense"
  | "refund"
  | "internal_transfer"
  | "credit_card_payment";

export type TransactionStatus = "posted" | "pending";

/** Whether the record originated in Hallix or arrived from a bank feed. */
export type TransactionOrigin = "manual" | "imported";

/** One department transaction, normalized for every analytics calculation. */
export type AnalyticsTransaction = {
  id: string;
  /** The calendar date used for every range filter and trend bucket. */
  date: IsoDate | null;
  /** Positive is money in, negative is money out. */
  signedCents: Cents | null;
  /** Always non-negative. Convenient for totals that ignore direction. */
  magnitudeCents: Cents;
  classification: TransactionClass;
  /** Why the classifier reached its conclusion, surfaced in tooltips. */
  classificationReason: string;
  status: TransactionStatus;
  origin: TransactionOrigin;
  vendor: string | null;
  category: string | null;
  accountName: string | null;
  accountId: string | null;
  fund: FundDesignation;
  isTwoPercent: boolean;
  hasReceipt: boolean;
  isReconciled: boolean;
  reconciledAt: string | null;
  isFlaggedDuplicate: boolean;
  hasDescription: boolean;
  twoPercentReviewStatus: string | null;
  description: string | null;
};

// ─── Period and comparison ────────────────────────────────────────────────────

export type DateRangePresetId =
  | "this_month"
  | "this_quarter"
  | "year_to_date"
  | "last_12_months"
  | "prior_calendar_year"
  | "custom";

export type ComparisonModeId = "previous_period" | "same_period_last_year" | "none";

export type DateRange = {
  /** Inclusive first day of the range. */
  start: IsoDate;
  /** Inclusive last day of the range. */
  end: IsoDate;
};

export type AnalyticsPeriod = {
  range: DateRange;
  preset: DateRangePresetId;
  label: string;
  /** Null when the comparison mode is `none` or no comparable range exists. */
  comparison: DateRange | null;
  comparisonMode: ComparisonModeId;
  comparisonLabel: string | null;
};

/**
 * A change between two periods.
 *
 * `percent` is null when the baseline is zero, because "up 100%" from nothing
 * is not a meaningful statement. Callers render the dollar change instead.
 */
export type PeriodChange = {
  currentCents: Cents;
  priorCents: Cents;
  deltaCents: Cents;
  percent: number | null;
  hasComparison: boolean;
};

// ─── Status vocabulary ────────────────────────────────────────────────────────

/**
 * The four-level status used by health, readiness and insight severity.
 * Every place that shows one of these also shows a text label, never colour
 * alone.
 */
export type StatusLevel = "positive" | "neutral" | "attention" | "risk" | "unknown";

export type InsightSeverity = "action_needed" | "watch" | "positive" | "informational";

/** A link from a metric to the records behind it. */
export type DrilldownTarget =
  | { kind: "transactions"; filters: TransactionDrilldownFilters }
  | { kind: "reconciliation"; queue: ReconciliationQueue }
  | { kind: "vendor"; vendorKey: string }
  | { kind: "accounts" }
  | { kind: "settings_accounts" };

export type TransactionDrilldownFilters = {
  category?: string;
  vendorQuery?: string;
  accountName?: string;
  dateFrom?: IsoDate;
  dateTo?: IsoDate;
  quickFilter?:
    | "all"
    | "needs_review"
    | "reconciled"
    | "income"
    | "expenses"
    | "missing_receipt"
    | "two_percent"
    | "this_month";
};

export type ReconciliationQueue =
  | "all"
  | "unreconciled"
  | "missing_receipt"
  | "duplicate"
  | "needs_review";

/**
 * A single supporting number behind an insight or health component.
 *
 * Insights are generated from these, and each insight carries the exact facts
 * it was generated from so the wording can always be traced back to a figure.
 */
export type MetricCitation = {
  label: string;
  value: string;
  /** The raw value, for tests and for callers that want to reformat. */
  rawValue: number | null;
};
