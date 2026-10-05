/**
 * Money In source categories — the single place that defines what kinds of
 * incoming money Hallix knows about and how each one behaves economically.
 *
 * Income categories are deliberately separate from expense categories. A
 * transfer between the department's own accounts is NOT a category here: it is
 * a transaction type (see `LedgerTransactionType`), so it can never be picked
 * as a "source" and counted as income.
 */

import type { CategorySeed } from "../category-seed";
import type { DepartmentCategory, ExpenseRecord, LedgerTransactionType } from "../types";

/** created_from marker for categories seeded by Money In. */
export const MONEY_IN_SEED_SOURCE = "money_in_seed";

export type MoneyInCategoryKey =
  | "two_percent"
  | "donation"
  | "fundraising"
  | "grant"
  | "hall_rental"
  | "membership_dues"
  | "interest"
  | "government"
  | "reimbursement"
  | "refund"
  | "asset_sale"
  | "other";

export type MoneyInCategoryConfig = {
  key: MoneyInCategoryKey;
  /** Stored category name. Reuses an existing Hallix category where one exists. */
  name: string;
  description: string;
  /** How the ledger treats it: income counts as Money In, refund nets spend. */
  economicType: Extract<LedgerTransactionType, "income" | "refund">;
  /** Receipts of this kind belong to the 2% (foreign fire insurance) fund. */
  twoPercent: boolean;
  /** Whether a payer of this kind is a donor (used for wording only). */
  donor: boolean;
  /** Analytics "Money in by source" bucket. */
  sourceBucket: MoneyInSourceBucket;
  /** Already seeded by the existing category bank — never seeded again here. */
  existingSeed?: boolean;
};

export type MoneyInSourceBucket =
  | "two_percent"
  | "donations"
  | "fundraisers"
  | "grants"
  | "hall_rentals"
  | "dues"
  | "interest"
  | "government"
  | "other";

export const MONEY_IN_SOURCE_BUCKET_LABELS: Record<MoneyInSourceBucket, string> = {
  two_percent: "2% Funds",
  donations: "Donations",
  fundraisers: "Fundraisers",
  grants: "Grants",
  hall_rentals: "Hall rentals",
  dues: "Membership dues",
  interest: "Interest",
  government: "Government payments",
  other: "Other income",
};

export const MONEY_IN_CATEGORIES: readonly MoneyInCategoryConfig[] = [
  { key: "two_percent", name: "NYS 2% Deposit", description: "2% Funds / Foreign Fire Insurance distribution", economicType: "income", twoPercent: true, donor: false, sourceBucket: "two_percent", existingSeed: true },
  { key: "donation", name: "Donations Received", description: "Donations and gifts received by the department", economicType: "income", twoPercent: false, donor: true, sourceBucket: "donations" },
  { key: "fundraising", name: "Fundraising Income", description: "Income from fundraising events", economicType: "income", twoPercent: false, donor: false, sourceBucket: "fundraisers", existingSeed: true },
  { key: "grant", name: "Grant", description: "Grant awards and grant payments", economicType: "income", twoPercent: false, donor: false, sourceBucket: "grants" },
  { key: "hall_rental", name: "Hall / Facility Rental", description: "Hall, room, or facility rental income", economicType: "income", twoPercent: false, donor: false, sourceBucket: "hall_rentals" },
  { key: "membership_dues", name: "Member Dues", description: "Member dues collected", economicType: "income", twoPercent: false, donor: false, sourceBucket: "dues", existingSeed: true },
  { key: "interest", name: "Interest Income", description: "Bank interest on general accounts", economicType: "income", twoPercent: false, donor: false, sourceBucket: "interest" },
  { key: "government", name: "Government Payment", description: "Payments from a town, village, county, or state agency", economicType: "income", twoPercent: false, donor: false, sourceBucket: "government" },
  { key: "reimbursement", name: "Reimbursement", description: "Money paid back to the department for costs it covered", economicType: "income", twoPercent: false, donor: false, sourceBucket: "other" },
  { key: "refund", name: "Refund", description: "Money returned by a vendor — nets against the original expense", economicType: "refund", twoPercent: false, donor: false, sourceBucket: "other" },
  { key: "asset_sale", name: "Sale of Equipment / Asset", description: "Proceeds from selling apparatus, equipment, or other assets", economicType: "income", twoPercent: false, donor: false, sourceBucket: "other" },
  { key: "other", name: "Other Income", description: "Other money received", economicType: "income", twoPercent: false, donor: false, sourceBucket: "other" },
];

export const MONEY_IN_FALLBACK_CATEGORY = "Other Income";

/** Seeds for categories Money In introduces (existing seeds are reused, not duplicated). */
export const MONEY_IN_CATEGORY_SEEDS: Omit<CategorySeed, "key">[] = MONEY_IN_CATEGORIES.filter(
  (c) => !c.existingSeed,
).map((c) => ({
  name: c.name,
  description: c.description,
  category_group: c.twoPercent ? "two_percent" : "general",
  default_type: "income",
  two_percent_guidance: c.twoPercent ? "likely_eligible" : "not_two_percent",
}));

function normalize(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function moneyInCategoryConfig(name: string | null | undefined): MoneyInCategoryConfig | null {
  const norm = normalize(name);
  if (!norm) return null;
  return MONEY_IN_CATEGORIES.find((c) => normalize(c.name) === norm) ?? null;
}

export function moneyInCategoryByKey(key: MoneyInCategoryKey): MoneyInCategoryConfig {
  return MONEY_IN_CATEGORIES.find((c) => c.key === key)!;
}

/** A department category is a 2% receipt category (e.g. NYS 2% Deposit, 2% Interest). */
export function isTwoPercentIncomeCategory(
  name: string | null | undefined,
  departmentCategories: DepartmentCategory[] = [],
): boolean {
  const config = moneyInCategoryConfig(name);
  if (config) return config.twoPercent;
  const norm = normalize(name);
  const managed = departmentCategories.find((c) => c.normalized_name === norm);
  return Boolean(managed && managed.category_group === "two_percent" && managed.default_type !== "expense");
}

/** Category Money In introduced — kept out of expense category dropdowns. */
export function isMoneyInOnlyCategory(category: DepartmentCategory): boolean {
  return category.created_from === MONEY_IN_SEED_SOURCE && category.default_type === "income";
}

/** A ledger row explicitly recorded through Money In (or a transfer leg). */
export function isTypedMoneyInRow(row: Pick<ExpenseRecord, "transaction_type">): boolean {
  return row.transaction_type === "income" || row.transaction_type === "refund" || row.transaction_type === "transfer";
}

/**
 * Category choices for a Money In record: the department's active income
 * categories (plus "both"), in the configured order first, then any income
 * categories the department added itself, then names used on earlier Money In
 * rows. Expense-only categories never appear.
 */
export function buildMoneyInCategoryOptions(
  departmentCategories: DepartmentCategory[] = [],
  ledgerRows: Pick<ExpenseRecord, "category" | "transaction_type" | "department_id">[] = [],
  departmentId?: string,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const push = (name: string) => {
    const key = normalize(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(name.trim());
  };

  const incomeCategories = departmentCategories.filter(
    (c) =>
      c.is_active !== false &&
      (c.default_type === "income" || c.default_type === "both") &&
      c.two_percent_guidance !== "potentially_not_allowed",
  );
  const byNorm = new Map(incomeCategories.map((c) => [c.normalized_name, c]));

  for (const config of MONEY_IN_CATEGORIES) {
    const managed = byNorm.get(normalize(config.name));
    // With no managed categories loaded yet, the configured list still works.
    if (managed || departmentCategories.length === 0) push(managed?.name ?? config.name);
  }
  const custom = incomeCategories
    .filter((c) => !seen.has(c.normalized_name))
    .sort((a, b) => {
      if (a.category_group !== b.category_group) return a.category_group === "two_percent" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  for (const c of custom) push(c.name);

  const expenseOnly = new Set(
    departmentCategories.filter((c) => c.default_type === "expense").map((c) => c.normalized_name),
  );
  for (const row of ledgerRows) {
    if (departmentId && row.department_id && row.department_id !== departmentId) continue;
    if (row.transaction_type !== "income" && row.transaction_type !== "refund") continue;
    const name = (row.category || "").trim();
    if (!name || expenseOnly.has(normalize(name))) continue;
    push(name);
  }

  if (!seen.has(normalize(MONEY_IN_FALLBACK_CATEGORY))) push(MONEY_IN_FALLBACK_CATEGORY);
  return result;
}

/** Economic type a Money In record is saved with. */
export function moneyInTransactionType(
  category: string | null | undefined,
  options: { relatedExpenseId?: string | null } = {},
): Extract<LedgerTransactionType, "income" | "refund"> {
  const config = moneyInCategoryConfig(category);
  if (config?.economicType === "refund") return "refund";
  if (config?.key === "reimbursement" && options.relatedExpenseId) return "refund";
  return "income";
}

export function moneyInSourceBucket(category: string | null | undefined, isTwoPercent: boolean): MoneyInSourceBucket {
  if (isTwoPercent) return "two_percent";
  const config = moneyInCategoryConfig(category);
  if (config) return config.sourceBucket;
  const c = normalize(category);
  if (/donat|gift/.test(c)) return "donations";
  if (/fundrais|raffle|event/.test(c)) return "fundraisers";
  if (/grant/.test(c)) return "grants";
  if (/rent|hall/.test(c)) return "hall_rentals";
  if (/dues/.test(c)) return "dues";
  if (/interest/.test(c)) return "interest";
  return "other";
}
