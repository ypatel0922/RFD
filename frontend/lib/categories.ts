/**
 * Category management utilities: seeding, usage stats, dropdown options,
 * and auto-suggestion for expense logging.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DepartmentCategory, DepartmentVendor, ExpenseRecord } from "./types";
import {
  GENERAL_CATEGORY_SEEDS,
  LEGACY_TWO_PERCENT_RENAMES,
  OTHER_2PCT_EXPENSE,
  TWO_PERCENT_CATEGORY_BANK,
  TWO_PERCENT_STARTER_NORMALIZED,
  type CategorySeed,
} from "./category-seed";
import { suggestTwoPctCategory } from "./two-percent-rules";

export function normalizeCategoryName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isUncategorizedCategory(category: string | null | undefined): boolean {
  const c = (category || "").trim();
  if (!c) return true;
  const lower = c.toLowerCase();
  return lower === "uncategorized" || lower === "—" || lower === "-";
}

export function isAllowedTwoPctCategory(category: DepartmentCategory): boolean {
  return (
    category.category_group === "two_percent" &&
    category.two_percent_guidance !== "potentially_not_allowed"
  );
}

export function isTwoPctDropdownVisible(
  category: DepartmentCategory,
  usageStats: Map<string, CategoryUsageStats>,
  twoPctMode: boolean,
): boolean {
  if (category.category_group === "general") {
    return category.is_active;
  }
  if (!isAllowedTwoPctCategory(category)) return false;
  if (!twoPctMode) return category.is_active;
  if (category.is_active) return true;
  if (TWO_PERCENT_STARTER_NORMALIZED.has(category.normalized_name)) return true;
  const usage = getUsageForCategory(category, usageStats);
  return usage.count > 0;
}

export type CategoryUsageStats = {
  count: number;
  lastUsed: string | null;
  twoPctCount: number;
  generalCount: number;
};

export function computeCategoryUsageStats(
  expenses: ExpenseRecord[],
): Map<string, CategoryUsageStats> {
  const stats = new Map<string, CategoryUsageStats>();

  for (const expense of expenses) {
    const cat = (expense.category || "").trim();
    if (!cat) continue;
    const key = normalizeCategoryName(cat);
    const existing = stats.get(key) || { count: 0, lastUsed: null, twoPctCount: 0, generalCount: 0 };
    existing.count += 1;
    if (expense.uses_two_percent_funds) {
      existing.twoPctCount += 1;
    } else {
      existing.generalCount += 1;
    }
    const date = expense.transaction_date || expense.created_at;
    if (date && (!existing.lastUsed || date > existing.lastUsed)) {
      existing.lastUsed = date;
    }
    stats.set(key, existing);
  }

  return stats;
}

export function getUsageForCategory(
  category: DepartmentCategory,
  usageStats: Map<string, CategoryUsageStats>,
): CategoryUsageStats {
  return (
    usageStats.get(category.normalized_name) || {
      count: 0,
      lastUsed: null,
      twoPctCount: 0,
      generalCount: 0,
    }
  );
}

function seedRowFromBank(seed: CategorySeed, departmentId: string) {
  const normalized = normalizeCategoryName(seed.name);
  return {
    department_id: departmentId,
    name: seed.name,
    normalized_name: normalized,
    description: seed.description,
    category_group: seed.category_group,
    default_type: seed.default_type,
    two_percent_guidance: seed.two_percent_guidance,
    is_system_default: true,
    is_active: Boolean(seed.starter),
    created_from: "system_seed",
  };
}

export async function seedDepartmentCategories(
  supabase: SupabaseClient,
  departmentId: string,
): Promise<void> {
  try {
    const { data: existingRows } = await supabase
      .from("department_categories")
      .select("*")
      .eq("department_id", departmentId);

    const existing = (existingRows || []) as DepartmentCategory[];
    const byNormalized = new Map(existing.map((r) => [r.normalized_name, r]));

    // Hide disallowed 2% categories — never show in dropdowns.
    const disallowed = existing.filter(
      (r) => r.two_percent_guidance === "potentially_not_allowed",
    );
    for (const row of disallowed) {
      if (row.is_active) {
        await supabase
          .from("department_categories")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("id", row.id);
      }
    }

    // Rename legacy long 2% names to short names when system-seeded and unused duplicate won't conflict.
    for (const [oldNorm, newName] of Object.entries(LEGACY_TWO_PERCENT_RENAMES)) {
      const row = byNormalized.get(oldNorm);
      if (!row || !row.is_system_default) continue;
      const newNorm = normalizeCategoryName(newName);
      if (byNormalized.has(newNorm) && byNormalized.get(newNorm)!.id !== row.id) continue;
      const bankEntry = TWO_PERCENT_CATEGORY_BANK.find(
        (s) => normalizeCategoryName(s.name) === newNorm,
      );
      await supabase
        .from("department_categories")
        .update({
          name: newName,
          normalized_name: newNorm,
          description: bankEntry?.description ?? row.description,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      byNormalized.delete(oldNorm);
      byNormalized.set(newNorm, { ...row, name: newName, normalized_name: newNorm });
    }

    const toInsert: ReturnType<typeof seedRowFromBank>[] = [];

    for (const seed of TWO_PERCENT_CATEGORY_BANK) {
      const norm = normalizeCategoryName(seed.name);
      if (!byNormalized.has(norm)) {
        toInsert.push(seedRowFromBank(seed, departmentId));
      }
    }

    for (const seed of GENERAL_CATEGORY_SEEDS) {
      const norm = normalizeCategoryName(seed.name);
      if (!byNormalized.has(norm)) {
        toInsert.push({
          department_id: departmentId,
          name: seed.name,
          normalized_name: norm,
          description: seed.description,
          category_group: seed.category_group,
          default_type: seed.default_type,
          two_percent_guidance: seed.two_percent_guidance,
          is_system_default: true,
          is_active: true,
          created_from: "system_seed",
        });
      }
    }

    if (toInsert.length > 0) {
      const { error } = await supabase.from("department_categories").insert(toInsert);
      if (error) throw error;
    }

    // Deactivate non-starter 2% categories bulk-seeded as active (keep if used in ledger).
    const { data: usedExpenseCats } = await supabase
      .from("expenses")
      .select("category")
      .eq("department_id", departmentId)
      .not("category", "is", null);

    const usedNormalized = new Set(
      ((usedExpenseCats || []) as { category: string }[])
        .map((e) => normalizeCategoryName(e.category))
        .filter(Boolean),
    );

    const { data: twoPctRows } = await supabase
      .from("department_categories")
      .select("id, normalized_name, is_active, created_from")
      .eq("department_id", departmentId)
      .eq("category_group", "two_percent")
      .eq("is_system_default", true);

    for (const row of (twoPctRows || []) as DepartmentCategory[]) {
      // Only demote bulk system seeds — never categories the user added from the bank.
      if (row.created_from !== "system_seed") continue;
      if (
        row.is_active &&
        !TWO_PERCENT_STARTER_NORMALIZED.has(row.normalized_name) &&
        !usedNormalized.has(row.normalized_name)
      ) {
        await supabase
          .from("department_categories")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("id", row.id);
      }
    }
  } catch {
    // Migration 017 columns required; skip if not applied.
  }
}

const GUIDANCE_SORT: Record<string, number> = {
  likely_eligible: 0,
  needs_review: 1,
  not_two_percent: 2,
};

function sortCategoriesForDropdown(
  categories: DepartmentCategory[],
  twoPctMode: boolean,
): DepartmentCategory[] {
  return [...categories].sort((a, b) => {
    if (twoPctMode) {
      if (a.category_group !== b.category_group) {
        return a.category_group === "two_percent" ? -1 : 1;
      }
      if (a.category_group === "two_percent") {
        const ga = GUIDANCE_SORT[a.two_percent_guidance] ?? 9;
        const gb = GUIDANCE_SORT[b.two_percent_guidance] ?? 9;
        if (ga !== gb) return ga - gb;
      }
    } else if (a.category_group !== b.category_group) {
      return a.category_group === "general" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

/** Build dropdown options — 2% mode only shows active/used allowed categories plus starters. */
export function buildCategoryOptions(
  expenses: ExpenseRecord[],
  departmentCategories?: DepartmentCategory[],
  options?: { twoPctMode?: boolean; includeHidden?: boolean },
): string[] {
  const twoPctMode = options?.twoPctMode ?? false;
  const includeHidden = options?.includeHidden ?? false;
  const usageStats = computeCategoryUsageStats(expenses);
  const seen = new Set<string>();
  const result: string[] = [];

  const visible = (departmentCategories || []).filter((c) => {
    if (includeHidden) return isAllowedTwoPctCategory(c) || c.category_group === "general";
    return isTwoPctDropdownVisible(c, usageStats, twoPctMode);
  });

  const sorted = sortCategoriesForDropdown(visible, twoPctMode);

  for (const dc of sorted) {
    if (!seen.has(dc.normalized_name)) {
      seen.add(dc.normalized_name);
      result.push(dc.name);
    }
  }

  // Historical values (includes manual entry — user can always type custom categories).
  const historical: string[] = [];
  for (const expense of expenses) {
    const cat = (expense.category || "").trim();
    if (!cat) continue;
    const key = normalizeCategoryName(cat);
    if (seen.has(key)) continue;
    if (twoPctMode) {
      const managed = departmentCategories?.find((c) => c.normalized_name === key);
      if (managed && managed.two_percent_guidance === "potentially_not_allowed") continue;
    }
    seen.add(key);
    historical.push(cat);
  }
  historical.sort((a, b) => a.localeCompare(b));

  return [...result, ...historical];
}

function resolveActiveCategoryName(
  name: string,
  departmentCategories?: DepartmentCategory[],
): string {
  if (!departmentCategories) return name;
  const norm = normalizeCategoryName(name);
  const match = departmentCategories.find((c) => c.normalized_name === norm);
  return match?.name ?? name;
}

/** OCR / memo keyword patterns — short 2% names only. */
const OCR_CATEGORY_PATTERNS: Array<{ pattern: RegExp; twoPct: string; general: string }> = [
  { pattern: /restaurant|deli|pizza|bagels?|catering|refreshment|meeting.*food/i, twoPct: "Meeting Food", general: "Food" },
  { pattern: /interest\s*credit|interest\s*earned|interest\s*income/i, twoPct: "2% Interest", general: "Miscellaneous" },
  { pattern: /\bnys\b|dfs|foreign\s*fire|2\s*%\s*deposit|two\s*percent\s*deposit/i, twoPct: "NYS 2% Deposit", general: "Miscellaneous" },
  { pattern: /uniform|parade|dress\s*shirt|jacket|embroid/i, twoPct: "Parade Uniforms", general: "PPE & Uniforms" },
  { pattern: /fasny/i, twoPct: "FASNY Dues", general: "Dues" },
  { pattern: /loan|cash\s*payment|vehicle\s*registr|losap|service\s*award/i, twoPct: OTHER_2PCT_EXPENSE, general: "Miscellaneous" },
  { pattern: /fuel|gas\s*station|petrol/i, twoPct: OTHER_2PCT_EXPENSE, general: "Fuel" },
  { pattern: /office\s*suppl|staples|paper/i, twoPct: "Office Equipment", general: "Office Supplies" },
  { pattern: /training|education|course/i, twoPct: "Training", general: "Training" },
  { pattern: /newsletter|publication/i, twoPct: "Newsletter", general: "Office Supplies" },
  { pattern: /attorney|auditor|accounting|legal/i, twoPct: "Legal & Admin", general: "Miscellaneous" },
  { pattern: /convention|conference/i, twoPct: "Conferences", general: "Travel" },
  { pattern: /donat/i, twoPct: "Donation", general: "Donations" },
];

function suggestFromText(
  text: string,
  isTwoPctAccount: boolean,
  departmentCategories?: DepartmentCategory[],
): string | null {
  if (!text.trim()) return null;

  for (const { pattern, twoPct, general } of OCR_CATEGORY_PATTERNS) {
    if (pattern.test(text)) {
      const preferred = isTwoPctAccount ? twoPct : general;
      return resolveActiveCategoryName(preferred, departmentCategories);
    }
  }

  if (isTwoPctAccount) {
    const suggested = suggestTwoPctCategory(text);
    if (suggested) return resolveActiveCategoryName(suggested, departmentCategories);
  }
  return null;
}

export function suggestCategoryForVendor(
  vendor: string,
  expenses: ExpenseRecord[],
  departmentVendors?: DepartmentVendor[],
): string {
  const normalized = vendor.trim().toLowerCase();
  if (!normalized) return "";

  const matching = expenses.filter((expense) => {
    const label = (expense.payee || expense.merchant_name || "").trim().toLowerCase();
    return label === normalized && (expense.category || "").trim();
  });

  if (matching.length > 0) {
    matching.sort((a, b) => {
      const da = a.transaction_date || a.created_at;
      const db = b.transaction_date || b.created_at;
      return db.localeCompare(da);
    });
    const recentCategory = matching[0].category!.trim();
    const counts = new Map<string, number>();
    for (const expense of matching) {
      const cat = expense.category!.trim();
      counts.set(cat, (counts.get(cat) || 0) + 1);
    }
    let topCategory = recentCategory;
    let topCount = 0;
    for (const [cat, count] of counts) {
      if (count > topCount) {
        topCount = count;
        topCategory = cat;
      }
    }
    return topCount > 1 ? topCategory : recentCategory;
  }

  if (departmentVendors) {
    const dv = departmentVendors.find((v) => v.normalized_name === normalized);
    if (dv?.default_category) return dv.default_category;
  }

  return "";
}

/** Unified category suggestion for expense logging and receipt confirmation. */
export function suggestCategory(params: {
  vendor?: string;
  description?: string | null;
  ocrText?: string | null;
  expenses: ExpenseRecord[];
  departmentCategories?: DepartmentCategory[];
  departmentVendors?: DepartmentVendor[];
  isTwoPctAccount?: boolean;
}): string | null {
  const {
    vendor = "",
    description,
    ocrText,
    expenses,
    departmentCategories,
    departmentVendors,
    isTwoPctAccount = false,
  } = params;

  const vendorSuggestion = suggestCategoryForVendor(vendor, expenses, departmentVendors);
  if (vendorSuggestion) return vendorSuggestion;

  const combinedText = [vendor, description, ocrText].filter(Boolean).join(" ");
  const textSuggestion = suggestFromText(combinedText, isTwoPctAccount, departmentCategories);
  if (textSuggestion) return textSuggestion;

  return null;
}

export function getBankEntriesNotActive(
  departmentCategories: DepartmentCategory[],
): CategorySeed[] {
  const activeOrPresent = new Set(
    departmentCategories
      .filter((c) => c.category_group === "two_percent" && c.is_active)
      .map((c) => c.normalized_name),
  );
  return TWO_PERCENT_CATEGORY_BANK.filter(
    (seed) => !activeOrPresent.has(normalizeCategoryName(seed.name)),
  );
}

export function getActiveTwoPctCategories(
  departmentCategories: DepartmentCategory[],
  usageStats: Map<string, CategoryUsageStats>,
): DepartmentCategory[] {
  return departmentCategories
    .filter(
      (c) =>
        isAllowedTwoPctCategory(c) &&
        (c.is_active || getUsageForCategory(c, usageStats).count > 0),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getCategoryDisplayStatus(
  category: DepartmentCategory,
): "active" | "hidden" | "custom" {
  if (!category.is_active) return "hidden";
  if (!category.is_system_default) return "custom";
  return "active";
}

export function formatCategoryLastUsed(iso: string | null): string {
  if (!iso) return "Never";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

export const GUIDANCE_LABELS: Record<string, string> = {
  likely_eligible: "Likely Eligible",
  needs_review: "Needs Review",
  potentially_not_allowed: "Potentially Not Allowed",
  not_two_percent: "Not 2%",
};

export const GUIDANCE_BADGE_CLASS: Record<string, string> = {
  likely_eligible: "fb-cat-badge--eligible",
  needs_review: "fb-cat-badge--review",
  potentially_not_allowed: "fb-cat-badge--warn",
  not_two_percent: "fb-cat-badge--neutral",
};

export const DEFAULT_TYPE_LABELS: Record<string, string> = {
  expense: "Expense",
  income: "Income",
  both: "Both",
};

export { TWO_PERCENT_CATEGORY_BANK, OTHER_2PCT_EXPENSE };
