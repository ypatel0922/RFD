/**
 * Automatic category and 2% fund suggestion for receipt extraction.
 *
 * Runs after OCR so the review screen opens with the category already filled.
 * Suggestions are guidance only — the user always confirms before saving.
 *
 * Resolution order:
 *   1. Explicit vendor → category mapping (department_vendors.default_category)
 *   2. Strong department-specific vendor history
 *   3. Plaid merchant/category metadata when already stored on a linked transaction
 *   4. AI classification returned by the existing receipt extraction call
 *   5. Keyword patterns (existing suggestCategory logic)
 *   6. No suggestion — the field stays on the existing Uncategorized default
 */

import { normalizeCategoryName, isUncategorizedCategory, suggestCategory } from "./categories";
import { evaluateTwoPercentStatus } from "./two-percent-rules";
import type { DepartmentCategory, DepartmentVendor, ExpenseRecord } from "./types";

export type CategorySuggestionSource =
  | "vendor_default"
  | "history"
  | "plaid"
  | "ai"
  | "keyword";

export type CategorySuggestion = {
  category: string;
  source: CategorySuggestionSource;
  confidence: number;
};

export type TwoPercentSuggestion = {
  suggested: boolean;
  confidence: number;
  reason: string;
};

export type VendorCategoryHistory = {
  /** Category name → number of matching posted expenses. */
  counts: Map<string, number>;
  total: number;
  /** Most frequent category, or null when there is no usable history. */
  topCategory: string | null;
  topCount: number;
  /** topCount / total, 0 when there is no history. */
  dominance: number;
  /** Fraction of matching expenses recorded against 2% funds. */
  twoPercentShare: number;
};

/** Minimum matching expenses before history is treated as a strong signal. */
const STRONG_HISTORY_MIN_SAMPLES = 2;
/** Minimum share of one category before history is treated as strong. */
const STRONG_HISTORY_MIN_DOMINANCE = 0.6;
/** Confidence below this leaves the category blank rather than guessing. */
const MIN_USABLE_CONFIDENCE = 0.4;
/** Confidence at or above this is treated as a high-confidence suggestion. */
export const HIGH_CONFIDENCE_THRESHOLD = 0.8;

/** Records that represent money movement rather than a categorizable purchase. */
const TRANSFER_LIKE = [
  "transfer",
  "wire",
  "interest earned",
  "interest payment",
  "dividend",
  "payroll",
  "direct deposit",
  "ach deposit",
  "atm deposit",
  "check deposit",
  "zelle",
  "venmo",
  "cashback",
  "cash back",
  "credit adjustment",
  "opening balance",
  "beginning balance",
];

function looksLikeTransferRecord(expense: ExpenseRecord): boolean {
  const text = [expense.payee, expense.merchant_name, expense.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!text) return false;
  return TRANSFER_LIKE.some((pattern) => text.includes(pattern));
}

/**
 * Normalize a vendor label for history matching.
 *
 * Drops store/terminal numbers so "CHIPOTLE #1234" and "Chipotle 1234" collapse
 * onto "chipotle". Deliberately conservative: it never merges vendors that
 * differ by an actual word.
 */
export function normalizeVendorKey(vendor: string | null | undefined): string {
  return (vendor || "")
    .trim()
    .toLowerCase()
    .replace(/[#*]/g, " ")
    .replace(/\b(?:store|str|loc|location|unit|terminal|term)\b\s*\d+/g, " ")
    .replace(/\b\d{2,}\b/g, " ")
    .replace(/[^a-z0-9&'\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function vendorTokens(key: string): string[] {
  return key.split(" ").filter(Boolean);
}

/**
 * True when one vendor key is a complete leading phrase of the other, e.g.
 * "chipotle" vs "chipotle mexican grill". Requires a meaningful shared prefix
 * so "home depot" and "home goods" never merge.
 */
function isVendorPrefixMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const shortTokens = a.length <= b.length ? vendorTokens(a) : vendorTokens(b);
  const longTokens = a.length <= b.length ? vendorTokens(b) : vendorTokens(a);
  if (shortTokens.length === 0 || shortTokens.length >= longTokens.length) return false;
  if (shortTokens.join("").length < 5) return false;
  return shortTokens.every((token, index) => token === longTokens[index]);
}

function expenseVendorKey(expense: ExpenseRecord): string {
  return normalizeVendorKey(expense.payee || expense.merchant_name || "");
}

/**
 * Collect how this department has previously categorized a vendor.
 *
 * Callers must pass only the authenticated department's expenses — this helper
 * never reaches across departments. Uncategorized and transfer-like records are
 * ignored so they cannot create a vendor mapping.
 */
export function buildVendorCategoryHistory(params: {
  vendor: string | null | undefined;
  expenses: ExpenseRecord[];
  departmentId?: string;
}): VendorCategoryHistory {
  const empty: VendorCategoryHistory = {
    counts: new Map(),
    total: 0,
    topCategory: null,
    topCount: 0,
    dominance: 0,
    twoPercentShare: 0,
  };

  const vendorKey = normalizeVendorKey(params.vendor);
  if (!vendorKey) return empty;

  const scoped = params.departmentId
    ? params.expenses.filter((expense) => expense.department_id === params.departmentId)
    : params.expenses;

  const usable = scoped.filter((expense) => {
    if (isUncategorizedCategory(expense.category)) return false;
    if (looksLikeTransferRecord(expense)) return false;
    return Boolean(expenseVendorKey(expense));
  });

  let matching = usable.filter((expense) => expenseVendorKey(expense) === vendorKey);

  if (matching.length === 0) {
    // Fall back to a conservative prefix match, but only when it is unambiguous.
    const candidateKeys = new Set(
      usable.map(expenseVendorKey).filter((key) => isVendorPrefixMatch(key, vendorKey)),
    );
    if (candidateKeys.size === 1) {
      const [onlyKey] = [...candidateKeys];
      matching = usable.filter((expense) => expenseVendorKey(expense) === onlyKey);
    }
  }

  if (matching.length === 0) return empty;

  const counts = new Map<string, number>();
  let twoPercentCount = 0;
  for (const expense of matching) {
    const category = (expense.category || "").trim();
    counts.set(category, (counts.get(category) || 0) + 1);
    if (expense.uses_two_percent_funds) twoPercentCount += 1;
  }

  // Ties resolve to the most recently used category.
  const byRecency = [...matching].sort((a, b) => {
    const da = a.transaction_date || a.created_at || "";
    const db = b.transaction_date || b.created_at || "";
    return db.localeCompare(da);
  });

  let topCategory: string | null = null;
  let topCount = 0;
  for (const expense of byRecency) {
    const category = (expense.category || "").trim();
    const count = counts.get(category) || 0;
    if (count > topCount) {
      topCount = count;
      topCategory = category;
    }
  }

  return {
    counts,
    total: matching.length,
    topCategory,
    topCount,
    dominance: matching.length > 0 ? topCount / matching.length : 0,
    twoPercentShare: matching.length > 0 ? twoPercentCount / matching.length : 0,
  };
}

/**
 * Map a proposed name onto the department's existing categories.
 * Returns the canonical stored name, or null when the name does not exist —
 * classification can never invent a category.
 */
export function resolveAllowedCategory(
  proposed: string | null | undefined,
  allowedCategories: string[],
): string | null {
  const name = (proposed || "").trim();
  if (!name || isUncategorizedCategory(name)) return null;
  const normalized = normalizeCategoryName(name);
  const match = allowedCategories.find((option) => normalizeCategoryName(option) === normalized);
  return match ?? null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export type CategorySuggestionInput = {
  vendor?: string | null;
  description?: string | null;
  ocrText?: string | null;
  /** Category names the department can actually use. */
  allowedCategories: string[];
  expenses: ExpenseRecord[];
  departmentId?: string;
  departmentCategories?: DepartmentCategory[];
  departmentVendors?: DepartmentVendor[];
  isTwoPctAccount?: boolean;
  /** Category proposed by the receipt extraction call. */
  aiCategory?: string | null;
  aiConfidence?: number | null;
  /** Plaid metadata already stored for a linked transaction, when present. */
  plaidCategory?: string | null;
  plaidMerchant?: string | null;
};

/**
 * Pick the most likely category for a freshly extracted receipt.
 * Returns null when nothing is confident enough, leaving the existing default.
 */
export function suggestExpenseCategory(
  input: CategorySuggestionInput,
): CategorySuggestion | null {
  const {
    vendor = "",
    description,
    ocrText,
    allowedCategories,
    departmentId,
    departmentCategories,
    departmentVendors,
    isTwoPctAccount = false,
    aiCategory,
    aiConfidence,
    plaidCategory,
    plaidMerchant,
  } = input;

  // Scope once, up front: nothing downstream may see another department's data.
  const expenses = departmentId
    ? input.expenses.filter((expense) => expense.department_id === departmentId)
    : input.expenses;

  // 1. Explicit vendor → category mapping maintained by the department.
  const vendorKey = normalizeVendorKey(vendor);
  if (vendorKey && departmentVendors) {
    const mapped = departmentVendors.find(
      (candidate) =>
        normalizeVendorKey(candidate.normalized_name) === vendorKey ||
        normalizeVendorKey(candidate.name) === vendorKey,
    );
    const resolved = resolveAllowedCategory(mapped?.default_category, allowedCategories);
    if (resolved) {
      return { category: resolved, source: "vendor_default", confidence: 0.95 };
    }
  }

  // 2. Department's own history for this vendor.
  const history = buildVendorCategoryHistory({ vendor, expenses });
  const historyCategory = resolveAllowedCategory(history.topCategory, allowedCategories);
  if (
    historyCategory &&
    history.total >= STRONG_HISTORY_MIN_SAMPLES &&
    history.dominance >= STRONG_HISTORY_MIN_DOMINANCE
  ) {
    return {
      category: historyCategory,
      source: "history",
      confidence: clamp01(0.7 + history.dominance * 0.25),
    };
  }

  // 3. Plaid metadata, when the receipt is linked to an imported transaction.
  const plaidResolved = resolveAllowedCategory(plaidCategory, allowedCategories);
  if (plaidResolved) {
    return { category: plaidResolved, source: "plaid", confidence: 0.7 };
  }

  // 4. AI classification from the receipt extraction call.
  const aiResolved = resolveAllowedCategory(aiCategory, allowedCategories);
  if (aiResolved) {
    const confidence = clamp01(aiConfidence ?? 0.6);
    if (confidence >= MIN_USABLE_CONFIDENCE) {
      return { category: aiResolved, source: "ai", confidence };
    }
  }

  // 5. Existing keyword/vendor heuristics, including Plaid's merchant label.
  const keyword = suggestCategory({
    vendor: vendor || plaidMerchant || "",
    description,
    ocrText: [ocrText, plaidCategory, plaidMerchant].filter(Boolean).join(" ") || null,
    expenses,
    departmentCategories,
    departmentVendors,
    isTwoPctAccount,
  });
  const keywordResolved = resolveAllowedCategory(keyword, allowedCategories);
  if (keywordResolved) {
    return { category: keywordResolved, source: "keyword", confidence: 0.55 };
  }

  // 6. Weak single-sample history is better than nothing, but clearly uncertain.
  if (historyCategory && history.total > 0) {
    return { category: historyCategory, source: "history", confidence: 0.5 };
  }

  return null;
}

/**
 * True when an extraction response still belongs to the draft on screen.
 * A slower earlier upload must not land on a newer one.
 */
export function shouldApplyExtractionResult(
  requestId: number,
  latestRequestId: number,
): boolean {
  return requestId === latestRequestId;
}

/**
 * Whether to show the "Suggested by Hallix" hint. Once the user edits the
 * category, the suggestion is gone for good on this expense.
 */
export function isSuggestionVisible(params: {
  suggestion: CategorySuggestion | null | undefined;
  currentCategory: string;
  userEdited: boolean;
}): boolean {
  const { suggestion, currentCategory, userEdited } = params;
  if (!suggestion || userEdited) return false;
  return normalizeCategoryName(currentCategory) === normalizeCategoryName(suggestion.category);
}

export type TwoPercentSuggestionInput = {
  vendor?: string | null;
  category?: string | null;
  description?: string | null;
  expenses: ExpenseRecord[];
  departmentId?: string;
  departmentCategories?: DepartmentCategory[];
  /** False when the department has no 2% account configured. */
  hasTwoPercentAccount: boolean;
  /** True when the chosen account is already a 2% account. */
  alreadyTwoPercent?: boolean;
  aiSuggestsTwoPercent?: boolean | null;
  aiConfidence?: number | null;
};

/**
 * Recommend — never decide — whether an expense belongs to the 2% fund.
 * Returns null when there is no meaningful signal, so the form stays quiet.
 */
export function suggestTwoPercentFunds(
  input: TwoPercentSuggestionInput,
): TwoPercentSuggestion | null {
  const {
    vendor,
    category,
    description,
    departmentId,
    departmentCategories,
    hasTwoPercentAccount,
    alreadyTwoPercent = false,
    aiSuggestsTwoPercent,
    aiConfidence,
  } = input;

  if (!hasTwoPercentAccount || alreadyTwoPercent) return null;

  const expenses = departmentId
    ? input.expenses.filter((expense) => expense.department_id === departmentId)
    : input.expenses;

  // Department history for this vendor is the strongest signal either way.
  const history = buildVendorCategoryHistory({ vendor, expenses });
  if (history.total >= STRONG_HISTORY_MIN_SAMPLES) {
    if (history.twoPercentShare >= STRONG_HISTORY_MIN_DOMINANCE) {
      return {
        suggested: true,
        confidence: clamp01(0.6 + history.twoPercentShare * 0.3),
        reason: "Similar purchases from this vendor were paid from 2% funds.",
      };
    }
    if (history.twoPercentShare <= 1 - STRONG_HISTORY_MIN_DOMINANCE) {
      // Normally an operating expense — stay silent.
      return null;
    }
  }

  // A category managed as a 2% category is a direct signal.
  const normalizedCategory = category ? normalizeCategoryName(category) : "";
  const managed = normalizedCategory
    ? departmentCategories?.find((entry) => entry.normalized_name === normalizedCategory)
    : undefined;
  if (
    managed?.category_group === "two_percent" &&
    managed.two_percent_guidance !== "potentially_not_allowed"
  ) {
    return {
      suggested: true,
      confidence: 0.8,
      reason: `${managed.name} is tracked as a 2% fund category.`,
    };
  }

  if (aiSuggestsTwoPercent) {
    const confidence = clamp01(aiConfidence ?? 0.6);
    if (confidence >= HIGH_CONFIDENCE_THRESHOLD) {
      return {
        suggested: true,
        confidence,
        reason: "Receipt details match common 2% fund spending.",
      };
    }
  }

  const evaluation = evaluateTwoPercentStatus({ vendor, category, description });
  if (evaluation?.status === "likely_eligible") {
    return { suggested: true, confidence: 0.65, reason: evaluation.reason };
  }

  return null;
}
