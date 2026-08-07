/**
 * Department-scoped reads for the Analytics dashboard.
 *
 * Every query here filters on the department the signed-in user belongs to and
 * names the columns it needs. Row Level Security is what actually enforces
 * tenant isolation — a tampered department id returns nothing, because the
 * policies check `department_members` for `auth.uid()` — but the filter is
 * always applied as well so the database is never asked for another
 * department's rows in the first place.
 *
 * Reads are bounded by the analytics window rather than pulling a department's
 * whole history, and receipt files are never fetched. Only the stored receipt
 * path is read, which is all the completeness measures need.
 */

import { supabase } from "../supabase";
import type { IsoDate } from "../reconciliation/dates";
import { DEFAULT_ANALYTICS_SETTINGS, type AnalyticsSourceData } from "./engine";
import { normalizeCategoryKey } from "./budgets";
import type {
  AnalyticsBankAccountRow,
  AnalyticsExpenseRow,
  AnalyticsExternalAccountRow,
  AnalyticsExternalTransactionRow,
  AnalyticsOpeningBalanceRow,
  AnalyticsVendorRow,
  DepartmentAnalyticsSettings,
  DepartmentBudgetRow,
  TwoPercentBasis,
} from "./types";

const EXPENSE_COLUMNS = [
  "id",
  "transaction_date",
  "created_at",
  "total_amount",
  "category",
  "payee",
  "merchant_name",
  "description",
  "fund",
  "payment_reference",
  "payment_method",
  "bank_account_name",
  "receipt_path",
  "original_filename",
  "extraction_status",
  "extraction_notes",
  "reconciliation_status",
  "reconciled_at",
  "reconciliation_candidate",
  "uses_two_percent_funds",
  "two_percent_review_status",
].join(",");

const BANK_ACCOUNT_COLUMNS = [
  "id",
  "name",
  "institution_name",
  "account_mask",
  "account_type",
  "fund_type",
  "is_two_percent_account",
  "is_default",
  "last_reconciled_at",
  "last_reconciled_ending_balance",
].join(",");

const EXTERNAL_TRANSACTION_COLUMNS = [
  "id",
  "external_account_id",
  "posted_date",
  "description",
  "amount",
  "pending",
  "expense_id",
  "match_status",
].join(",");

/**
 * Upper bound on rows read for one dashboard load. Well beyond what a
 * department accumulates in the analytics window, but it stops a runaway query
 * if something upstream goes wrong.
 */
const MAX_ROWS = 20_000;

export class AnalyticsDataError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AnalyticsDataError";
    this.cause = cause;
  }
}

/**
 * A message safe to show a treasurer. Raw Postgres errors leak column names and
 * constraint internals, so they are logged and replaced.
 */
export function friendlyDataError(error: unknown): string {
  if (error instanceof AnalyticsDataError) return error.message;
  return "Analytics could not load right now. Try again in a moment.";
}

function logAnalyticsError(scope: string, error: unknown): void {
  console.error(`[analytics] ${scope} failed`, error);
}

/**
 * A missing table means the department's project has not run the analytics
 * migration yet. That is a setup state, not a failure, so those reads degrade
 * to empty rather than breaking the whole page.
 */
function isMissingRelation(message: string | undefined): boolean {
  return /does not exist|schema cache|could not find the table/i.test(message ?? "");
}

export async function fetchAnalyticsData(options: {
  departmentId: string;
  from: IsoDate;
  to: IsoDate;
}): Promise<AnalyticsSourceData> {
  const { departmentId, from, to } = options;

  const [
    expenses,
    bankAccounts,
    externalAccounts,
    externalTransactions,
    openingBalances,
    budgets,
    knownVendors,
  ] = await Promise.all([
    fetchExpenses(departmentId, from, to),
    fetchBankAccounts(departmentId),
    fetchExternalAccounts(departmentId),
    fetchExternalTransactions(departmentId, from, to),
    fetchOpeningBalances(departmentId),
    fetchBudgets(departmentId),
    fetchKnownVendors(departmentId),
  ]);

  return {
    expenses,
    bankAccounts,
    externalAccounts,
    externalTransactions,
    openingBalances,
    budgets,
    knownVendors,
  };
}

async function fetchKnownVendors(departmentId: string): Promise<AnalyticsVendorRow[]> {
  const { data, error } = await supabase
    .from("department_vendors")
    .select("id,name,normalized_name,default_category")
    .eq("department_id", departmentId)
    .order("name", { ascending: true });

  if (error) {
    if (isMissingRelation(error.message)) return [];
    logAnalyticsError("department_vendors", error);
    return [];
  }
  return (data ?? []) as unknown as AnalyticsVendorRow[];
}

async function fetchExpenses(
  departmentId: string,
  from: IsoDate,
  to: IsoDate,
): Promise<AnalyticsExpenseRow[]> {
  // Rows with no transaction_date fall back to created_at everywhere else, so
  // they are fetched too rather than silently dropped from every total.
  const { data, error } = await supabase
    .from("expenses")
    .select(EXPENSE_COLUMNS)
    .eq("department_id", departmentId)
    .or(`and(transaction_date.gte.${from},transaction_date.lte.${to}),transaction_date.is.null`)
    .order("transaction_date", { ascending: false })
    .limit(MAX_ROWS);

  if (error) {
    logAnalyticsError("expenses", error);
    throw new AnalyticsDataError("Transactions could not be loaded for this period.", error);
  }
  return (data ?? []) as unknown as AnalyticsExpenseRow[];
}

async function fetchBankAccounts(departmentId: string): Promise<AnalyticsBankAccountRow[]> {
  const { data, error } = await supabase
    .from("bank_accounts")
    .select(BANK_ACCOUNT_COLUMNS)
    .eq("department_id", departmentId)
    .order("created_at", { ascending: true });

  if (error) {
    if (isMissingRelation(error.message)) return [];
    logAnalyticsError("bank_accounts", error);
    throw new AnalyticsDataError("Accounts could not be loaded.", error);
  }
  return (data ?? []) as unknown as AnalyticsBankAccountRow[];
}

async function fetchExternalAccounts(
  departmentId: string,
): Promise<AnalyticsExternalAccountRow[]> {
  const { data, error } = await supabase
    .from("external_accounts")
    .select("id,name,mask,type,subtype")
    .eq("department_id", departmentId);

  if (error) {
    if (isMissingRelation(error.message)) return [];
    logAnalyticsError("external_accounts", error);
    return [];
  }
  return (data ?? []) as unknown as AnalyticsExternalAccountRow[];
}

async function fetchExternalTransactions(
  departmentId: string,
  from: IsoDate,
  to: IsoDate,
): Promise<AnalyticsExternalTransactionRow[]> {
  const { data, error } = await supabase
    .from("external_transactions")
    .select(EXTERNAL_TRANSACTION_COLUMNS)
    .eq("department_id", departmentId)
    .or(`and(posted_date.gte.${from},posted_date.lte.${to}),posted_date.is.null`)
    .limit(MAX_ROWS);

  if (error) {
    if (isMissingRelation(error.message)) return [];
    logAnalyticsError("external_transactions", error);
    return [];
  }
  return (data ?? []) as unknown as AnalyticsExternalTransactionRow[];
}

async function fetchOpeningBalances(
  departmentId: string,
): Promise<AnalyticsOpeningBalanceRow[]> {
  const { data, error } = await supabase
    .from("onboarding_beginning_balances")
    .select("account_id,account_name,account_type,beginning_balance,balance_date")
    .eq("department_id", departmentId);

  if (error) {
    if (isMissingRelation(error.message)) return [];
    logAnalyticsError("onboarding_beginning_balances", error);
    return [];
  }
  return (data ?? []) as unknown as AnalyticsOpeningBalanceRow[];
}

// ─── Budgets ──────────────────────────────────────────────────────────────────

export async function fetchBudgets(departmentId: string): Promise<DepartmentBudgetRow[]> {
  const { data, error } = await supabase
    .from("department_budgets")
    .select("id,department_id,fiscal_year,category,normalized_category,amount,notes")
    .eq("department_id", departmentId)
    .order("category", { ascending: true });

  if (error) {
    if (isMissingRelation(error.message)) return [];
    logAnalyticsError("department_budgets", error);
    return [];
  }
  return (data ?? []) as unknown as DepartmentBudgetRow[];
}

export async function saveBudget(options: {
  departmentId: string;
  fiscalYear: number;
  category: string;
  amountDollars: number;
  userId: string | null;
}): Promise<void> {
  const category = options.category.trim();
  if (!category) throw new AnalyticsDataError("Enter a category name for the budget.");
  if (!Number.isFinite(options.amountDollars) || options.amountDollars < 0) {
    throw new AnalyticsDataError("Enter a budget amount of zero or more.");
  }

  const { error } = await supabase.from("department_budgets").upsert(
    {
      department_id: options.departmentId,
      fiscal_year: options.fiscalYear,
      category,
      normalized_category: normalizeCategoryKey(category),
      amount: options.amountDollars,
      created_by: options.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "department_id,fiscal_year,normalized_category" },
  );

  if (error) {
    logAnalyticsError("save budget", error);
    throw new AnalyticsDataError("That budget could not be saved.", error);
  }
}

export async function deleteBudget(budgetId: string): Promise<void> {
  const { error } = await supabase.from("department_budgets").delete().eq("id", budgetId);
  if (error) {
    logAnalyticsError("delete budget", error);
    throw new AnalyticsDataError("That budget could not be removed.", error);
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function fetchAnalyticsSettings(
  departmentId: string,
): Promise<DepartmentAnalyticsSettings> {
  const fallback: DepartmentAnalyticsSettings = {
    department_id: departmentId,
    ...DEFAULT_ANALYTICS_SETTINGS,
  };

  const { data, error } = await supabase
    .from("department_analytics_settings")
    .select("department_id,two_percent_target_percent,two_percent_basis,fiscal_year_start_month")
    .eq("department_id", departmentId)
    .maybeSingle();

  if (error) {
    if (!isMissingRelation(error.message)) logAnalyticsError("analytics settings", error);
    return fallback;
  }
  if (!data) return fallback;

  const row = data as {
    department_id: string;
    two_percent_target_percent: string | number | null;
    two_percent_basis: string | null;
    fiscal_year_start_month: number | null;
  };

  return {
    department_id: row.department_id,
    two_percent_target_percent:
      Number(row.two_percent_target_percent ?? DEFAULT_ANALYTICS_SETTINGS.two_percent_target_percent) ||
      DEFAULT_ANALYTICS_SETTINGS.two_percent_target_percent,
    two_percent_basis: (row.two_percent_basis === "current_year_receipts"
      ? "current_year_receipts"
      : "total_available") as TwoPercentBasis,
    fiscal_year_start_month: row.fiscal_year_start_month ?? 1,
  };
}

export async function saveAnalyticsSettings(options: {
  departmentId: string;
  targetPercent: number;
  basis: TwoPercentBasis;
  userId: string | null;
}): Promise<void> {
  if (!Number.isFinite(options.targetPercent) || options.targetPercent < 0 || options.targetPercent > 100) {
    throw new AnalyticsDataError("Enter a target between 0 and 100 percent.");
  }

  const { error } = await supabase.from("department_analytics_settings").upsert(
    {
      department_id: options.departmentId,
      two_percent_target_percent: options.targetPercent,
      two_percent_basis: options.basis,
      updated_by: options.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "department_id" },
  );

  if (error) {
    logAnalyticsError("save analytics settings", error);
    throw new AnalyticsDataError("The 2% target could not be saved.", error);
  }
}

// ─── Account classification ───────────────────────────────────────────────────

/**
 * Record what kind of account this is. Written from the Analytics setup step so
 * cash and card balances can be told apart without guessing from the name.
 *
 * The 2% designation lives in `is_two_percent_account` and is set from Settings.
 * A 2% account's `fund_type` is left untouched here so classifying it as, say,
 * a savings account cannot clear its 2% marker.
 */
/**
 * Marks an account as holding the department's 2% money.
 *
 * This writes the same two fields Settings already writes — and the same
 * `nys_2_percent` fund value — so an account designated from Analytics is
 * indistinguishable from one designated in Settings. Nothing else about the
 * account is touched.
 */
export async function saveTwoPercentDesignation(options: {
  accountId: string;
  isTwoPercentAccount: boolean;
}): Promise<void> {
  const { error } = await supabase
    .from("bank_accounts")
    .update({
      is_two_percent_account: options.isTwoPercentAccount,
      fund_type: options.isTwoPercentAccount ? "nys_2_percent" : null,
    })
    .eq("id", options.accountId);

  if (error) {
    logAnalyticsError("save two percent designation", error);
    throw new AnalyticsDataError("That account could not be marked as the 2% account.", error);
  }
}

export async function saveAccountClassification(options: {
  accountId: string;
  accountType: string;
  fundType: string | null;
  isTwoPercentAccount: boolean;
}): Promise<void> {
  const update: { account_type: string | null; fund_type?: string | null } = {
    account_type: options.accountType || null,
  };
  if (!options.isTwoPercentAccount) {
    update.fund_type = options.fundType || null;
  }

  const { error } = await supabase.from("bank_accounts").update(update).eq("id", options.accountId);

  if (error) {
    logAnalyticsError("save account classification", error);
    throw new AnalyticsDataError("That account could not be updated.", error);
  }
}
