/**
 * Category and 2% suggestions for Money In.
 *
 * Resolution order (first confident answer wins):
 *   1. Strong department history for this payer
 *   2. The payer's saved default category (department_counterparties)
 *   3. Clear wording on the check / document / memo
 *   4. Plaid bank description, when the record came from a bank credit
 *   5. AI classification from document extraction
 *   6. Weak history, then the safe "Other Income" fallback
 *
 * Every answer is resolved against the department's allowed Money In
 * categories, so a suggestion can never invent a category. Suggestions are
 * guidance only: the user's choice always wins.
 */

import { normalizeVendorKey, resolveAllowedCategory } from "../category-suggestion";
import { isLedgerInflow } from "../reconciliation/ledger";
import type { DepartmentCategory, DepartmentCounterparty, ExpenseRecord } from "../types";
import {
  isTwoPercentIncomeCategory,
  moneyInCategoryByKey,
  moneyInCategoryConfig,
  MONEY_IN_FALLBACK_CATEGORY,
  type MoneyInCategoryKey,
} from "./categories";

export type MoneyInSuggestionSource =
  | "history"
  | "payer_default"
  | "document"
  | "plaid"
  | "ai"
  | "history_weak"
  | "fallback";

export type MoneyInCategorySuggestion = {
  category: string;
  source: MoneyInSuggestionSource;
  confidence: number;
  reason: string;
};

export type MoneyInTwoPercentSuggestion = {
  suggested: true;
  confidence: number;
  reason: string;
};

type HistoryRow = Pick<
  ExpenseRecord,
  | "department_id"
  | "payee"
  | "merchant_name"
  | "category"
  | "total_amount"
  | "fund"
  | "transaction_type"
  | "uses_two_percent_funds"
  | "transaction_date"
  | "created_at"
>;

const STRONG_HISTORY_MIN_SAMPLES = 2;
const STRONG_HISTORY_MIN_DOMINANCE = 0.6;
const MIN_AI_CONFIDENCE = 0.4;
const HIGH_CONFIDENCE = 0.8;

/** Wording that clearly identifies a source. Order matters: earlier wins. */
const SOURCE_RULES: Array<{ key: MoneyInCategoryKey; pattern: RegExp }> = [
  {
    key: "two_percent",
    pattern:
      /foreign\s*fire|\b2\s*%\s*(?:fund|distribution|tax|deposit|money)|two\s*percent|\bdfs\b|department\s+of\s+financial\s+services|fire\s+insurance\s+(?:tax|premium)/i,
  },
  { key: "refund", pattern: /\brefund|credit\s*memo|overpayment|returned\s+(?:item|merchandise|goods)|\breturn\s+credit/i },
  { key: "grant", pattern: /\bgrant\b|\bafg\b|\bsafer\b|award\s+letter/i },
  { key: "hall_rental", pattern: /hall\s+rental|facility\s+rental|room\s+rental|hall\s+rent|rental\s+of\s+(?:the\s+)?hall/i },
  { key: "membership_dues", pattern: /\bdues\b|membership\s+fee/i },
  { key: "reimbursement", pattern: /reimburs/i },
  { key: "asset_sale", pattern: /sale\s+of\s+(?:equipment|apparatus|truck|engine|vehicle|asset)|surplus\s+(?:sale|equipment)|\bauction\b/i },
  { key: "donation", pattern: /donat|in\s+memory\s+of|memorial|\bgift\b|contribution/i },
  { key: "fundraising", pattern: /fundrais|raffle|pancake|car\s*wash|golf\s+outing|\bbbq\b|chicken\s+barbecue|beef\s*steak|50\s*\/\s*50|ticket\s+sales|fund\s+drive|mail\s+drive/i },
  { key: "interest", pattern: /\binterest\b|\bdividend\b/i },
  { key: "government", pattern: /\b(?:town|village|county|city|state)\s+of\b|fire\s+district|municipal/i },
];

function normalize(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Incoming rows usable as source history (never transfers). */
export function isMoneyInHistoryRow(row: HistoryRow): boolean {
  if (row.transaction_type === "income" || row.transaction_type === "refund") return true;
  if (row.transaction_type) return false;
  return isLedgerInflow(row);
}

export type PayerHistory = {
  total: number;
  topCategory: string | null;
  dominance: number;
  twoPercentShare: number;
};

/** How this department has categorized earlier money from this payer. */
export function buildPayerHistory(params: {
  payer: string | null | undefined;
  ledgerRows: HistoryRow[];
  departmentId: string;
}): PayerHistory {
  const key = normalizeVendorKey(params.payer);
  const empty: PayerHistory = { total: 0, topCategory: null, dominance: 0, twoPercentShare: 0 };
  if (!key) return empty;
  const matching = params.ledgerRows.filter(
    (row) =>
      row.department_id === params.departmentId &&
      isMoneyInHistoryRow(row) &&
      Boolean((row.category || "").trim()) &&
      normalizeVendorKey(row.payee || row.merchant_name) === key,
  );
  if (!matching.length) return empty;

  const counts = new Map<string, number>();
  let twoPct = 0;
  for (const row of matching) {
    const category = (row.category || "").trim();
    counts.set(category, (counts.get(category) || 0) + 1);
    if (row.uses_two_percent_funds) twoPct += 1;
  }
  const byRecency = [...matching].sort((a, b) =>
    (b.transaction_date || b.created_at || "").localeCompare(a.transaction_date || a.created_at || ""),
  );
  let topCategory: string | null = null;
  let topCount = 0;
  for (const row of byRecency) {
    const category = (row.category || "").trim();
    const count = counts.get(category) || 0;
    if (count > topCount) {
      topCount = count;
      topCategory = category;
    }
  }
  return {
    total: matching.length,
    topCategory,
    dominance: topCount / matching.length,
    twoPercentShare: twoPct / matching.length,
  };
}

/** The configured source a piece of text clearly describes, if any. */
export function matchSourceRule(text: string | null | undefined): MoneyInCategoryKey | null {
  const value = (text || "").trim();
  if (!value) return null;
  for (const rule of SOURCE_RULES) {
    if (rule.pattern.test(value)) return rule.key;
  }
  return null;
}

function resolveKey(key: MoneyInCategoryKey | null, allowed: string[]): string | null {
  if (!key) return null;
  return resolveAllowedCategory(moneyInCategoryByKey(key).name, allowed);
}

export type MoneyInCategoryInput = {
  payer?: string | null;
  memo?: string | null;
  /** Free text read from the document (designation, letter wording…). */
  documentText?: string | null;
  plaidDescription?: string | null;
  aiCategory?: string | null;
  aiConfidence?: number | null;
  /** Money In category names the department can use. */
  allowedCategories: string[];
  ledgerRows: HistoryRow[];
  departmentId: string;
  counterparties?: Pick<DepartmentCounterparty, "department_id" | "normalized_name" | "default_category">[];
};

export function suggestMoneyInCategory(input: MoneyInCategoryInput): MoneyInCategorySuggestion | null {
  const allowed = input.allowedCategories;
  if (!allowed.length) return null;

  const history = buildPayerHistory({
    payer: input.payer,
    ledgerRows: input.ledgerRows,
    departmentId: input.departmentId,
  });
  if (history.total >= STRONG_HISTORY_MIN_SAMPLES && history.dominance >= STRONG_HISTORY_MIN_DOMINANCE) {
    const category = resolveAllowedCategory(history.topCategory, allowed);
    if (category) {
      return {
        category,
        source: "history",
        confidence: Math.min(0.95, 0.6 + history.dominance * 0.35),
        reason: `Earlier money from this payer was recorded as ${category}.`,
      };
    }
  }

  const payerKey = normalize(input.payer);
  if (payerKey) {
    const mapping = (input.counterparties || []).find(
      (c) => c.department_id === input.departmentId && c.normalized_name === payerKey,
    );
    const category = resolveAllowedCategory(mapping?.default_category, allowed);
    if (category) {
      return { category, source: "payer_default", confidence: 0.85, reason: `Saved default for ${input.payer?.trim()}.` };
    }
  }

  const documentText = [input.memo, input.documentText, input.payer].filter(Boolean).join(" \n ");
  const fromDocument = resolveKey(matchSourceRule(documentText), allowed);
  if (fromDocument) {
    return { category: fromDocument, source: "document", confidence: 0.75, reason: "Based on the wording on the document." };
  }

  const fromPlaid = resolveKey(matchSourceRule(input.plaidDescription), allowed);
  if (fromPlaid) {
    return { category: fromPlaid, source: "plaid", confidence: 0.6, reason: "Based on the bank description." };
  }

  const aiCategory = resolveAllowedCategory(input.aiCategory, allowed);
  const aiConfidence = Number.isFinite(input.aiConfidence ?? NaN) ? (input.aiConfidence as number) : 0.5;
  if (aiCategory && aiConfidence >= MIN_AI_CONFIDENCE) {
    return { category: aiCategory, source: "ai", confidence: Math.min(1, aiConfidence), reason: "Suggested from the document." };
  }

  if (history.total > 0) {
    const category = resolveAllowedCategory(history.topCategory, allowed);
    if (category) {
      return { category, source: "history_weak", confidence: 0.45, reason: `Last time this payer was recorded as ${category}.` };
    }
  }

  const fallback = resolveAllowedCategory(MONEY_IN_FALLBACK_CATEGORY, allowed);
  return fallback ? { category: fallback, source: "fallback", confidence: 0.2, reason: "No clear source yet." } : null;
}

/** Fallback defaults are pre-filled quietly; everything else gets a "Suggested" badge. */
export function isBadgedSuggestion(suggestion: MoneyInCategorySuggestion | null | undefined): boolean {
  return Boolean(suggestion && suggestion.source !== "fallback");
}

export type MoneyInTwoPercentInput = {
  payer?: string | null;
  memo?: string | null;
  documentText?: string | null;
  plaidDescription?: string | null;
  category?: string | null;
  ledgerRows: HistoryRow[];
  departmentId: string;
  departmentCategories?: DepartmentCategory[];
  aiSuggestsTwoPercent?: boolean | null;
  aiConfidence?: number | null;
  depositAccountIsTwoPercent?: boolean;
  alreadyTwoPercent?: boolean;
};

/**
 * Whether this money looks like a 2% (foreign fire insurance) receipt.
 * Only ever a suggestion — Hallix never decides 2% status on its own, and an
 * ordinary donation stays ordinary income unless the user says otherwise.
 */
export function suggestMoneyInTwoPercent(input: MoneyInTwoPercentInput): MoneyInTwoPercentSuggestion | null {
  if (input.alreadyTwoPercent) return null;

  const documentText = [input.memo, input.documentText, input.payer].filter(Boolean).join(" \n ");
  if (matchSourceRule(documentText) === "two_percent") {
    return {
      suggested: true,
      confidence: 0.85,
      reason: "The document mentions foreign fire insurance / 2% funds. Confirm before saving.",
    };
  }

  const history = buildPayerHistory({ payer: input.payer, ledgerRows: input.ledgerRows, departmentId: input.departmentId });
  if (history.total >= STRONG_HISTORY_MIN_SAMPLES) {
    if (history.twoPercentShare >= STRONG_HISTORY_MIN_DOMINANCE) {
      return { suggested: true, confidence: 0.8, reason: "Earlier money from this payer was recorded as 2% Funds." };
    }
    if (history.twoPercentShare <= 1 - STRONG_HISTORY_MIN_DOMINANCE) return null;
  }

  if (isTwoPercentIncomeCategory(input.category, input.departmentCategories)) {
    return { suggested: true, confidence: 0.8, reason: `${input.category} is a 2% Funds receipt category.` };
  }

  if (matchSourceRule(input.plaidDescription) === "two_percent") {
    return { suggested: true, confidence: 0.7, reason: "The bank description mentions a 2% / foreign fire distribution." };
  }

  if (input.aiSuggestsTwoPercent && (input.aiConfidence ?? 0) >= HIGH_CONFIDENCE) {
    return { suggested: true, confidence: input.aiConfidence as number, reason: "The document looks like a 2% Funds distribution." };
  }

  // The destination account alone is weak evidence; a clearly non-2% source
  // (a donation, a hall rental…) stays ordinary income.
  const config = moneyInCategoryConfig(input.category);
  if (input.depositAccountIsTwoPercent && (!config || config.key === "other")) {
    return { suggested: true, confidence: 0.5, reason: "This is being deposited to your 2% Funds account." };
  }

  return null;
}
