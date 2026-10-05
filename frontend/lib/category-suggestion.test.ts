/**
 * Automatic categorization of extracted receipts.
 *
 * The treasurer never sees these rules directly — they see a category already
 * filled in on the review screen. So the invariants that matter are: never
 * invent a category, never cross departments, and never overrule the user.
 */

import { describe, expect, it } from "vitest";

import {
  buildVendorCategoryHistory,
  isSuggestionVisible,
  normalizeVendorKey,
  resolveAllowedCategory,
  shouldApplyExtractionResult,
  suggestExpenseCategory,
  suggestTwoPercentFunds,
} from "./category-suggestion";
import { suggestCategory } from "./categories";
import type { DepartmentCategory, DepartmentVendor, ExpenseRecord } from "./types";

const DEPT = "dept-alpha";
const OTHER_DEPT = "dept-beta";

const ALLOWED = [
  "Food",
  "Fuel",
  "Office Supplies",
  "PPE & Uniforms",
  "Repairs & Maintenance",
  "Training",
  "Equipment",
  "Meeting Food",
  "Miscellaneous",
];

function expense(overrides: Partial<ExpenseRecord> = {}): ExpenseRecord {
  return {
    id: crypto.randomUUID(),
    department_id: DEPT,
    receipt_id: "r",
    receipt_path: "path",
    original_filename: "receipt.jpg",
    content_type: "image/jpeg",
    created_at: "2026-01-01T00:00:00.000Z",
    created_by_user_id: "u",
    created_by_email: "u@example.com",
    uploaded_by: "Treasurer",
    fund: null,
    payment_reference: null,
    payee: null,
    description: null,
    bank_account_name: "Operating",
    merchant_name: null,
    transaction_date: "2026-01-01",
    total_amount: 100,
    tax_amount: null,
    balance_after_transaction: null,
    category: null,
    payment_method: null,
    extraction_status: "extracted",
    extraction_confidence: 1,
    extraction_notes: null,
    reconciliation_status: "pending_bank_match",
    bank_match_confidence: 0,
    ...overrides,
  } as ExpenseRecord;
}

function categoryRow(overrides: Partial<DepartmentCategory>): DepartmentCategory {
  return {
    id: crypto.randomUUID(),
    department_id: DEPT,
    name: "Meeting Food",
    normalized_name: "meeting food",
    description: null,
    category_group: "two_percent",
    default_type: "expense",
    two_percent_guidance: "likely_eligible",
    is_system_default: true,
    is_active: true,
    created_from: "system_seed",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function history(vendor: string, categories: string[], extra: Partial<ExpenseRecord> = {}) {
  return categories.map((category) => expense({ payee: vendor, category, ...extra }));
}

describe("restaurant receipts land on Food", () => {
  it("fills the category from the extraction call", () => {
    const suggestion = suggestExpenseCategory({
      vendor: "Chipotle",
      ocrText: "burrito bowl chips queso",
      allowedCategories: ALLOWED,
      expenses: [],
      departmentId: DEPT,
      aiCategory: "Food",
      aiConfidence: 0.94,
    });

    expect(suggestion).toMatchObject({ category: "Food", source: "ai" });
  });

  it("falls back to keyword patterns when the model says nothing", () => {
    const suggestion = suggestExpenseCategory({
      vendor: "Mario's Pizza Restaurant",
      allowedCategories: ALLOWED,
      expenses: [],
      departmentId: DEPT,
    });

    expect(suggestion?.category).toBe("Food");
  });
});

describe("the category list is a closed set", () => {
  it("drops a category the department does not have", () => {
    const suggestion = suggestExpenseCategory({
      vendor: "Chipotle",
      allowedCategories: ["Fuel", "Training"],
      expenses: [],
      departmentId: DEPT,
      aiCategory: "Catering & Banquets",
      aiConfidence: 0.99,
    });

    expect(suggestion).toBeNull();
  });

  it("maps a proposed name onto the stored spelling", () => {
    expect(resolveAllowedCategory("  food ", ALLOWED)).toBe("Food");
    expect(resolveAllowedCategory("Invented Category", ALLOWED)).toBeNull();
    expect(resolveAllowedCategory("Uncategorized", ALLOWED)).toBeNull();
  });
});

describe("the department's own bookkeeping comes first", () => {
  it("prefers a dominant historical category over the model", () => {
    const suggestion = suggestExpenseCategory({
      vendor: "Home Depot",
      allowedCategories: ALLOWED,
      expenses: [
        ...history("Home Depot", Array(8).fill("Equipment")),
        ...history("Home Depot", ["Repairs & Maintenance"]),
      ],
      departmentId: DEPT,
      aiCategory: "Office Supplies",
      aiConfidence: 0.9,
    });

    expect(suggestion).toMatchObject({ category: "Equipment", source: "history" });
  });

  it("defers to the receipt when history is split", () => {
    const suggestion = suggestExpenseCategory({
      vendor: "Home Depot",
      allowedCategories: ALLOWED,
      expenses: [
        ...history("Home Depot", ["Food", "Food", "Food"]),
        ...history("Home Depot", ["Meeting Food", "Meeting Food", "Meeting Food"]),
        ...history("Home Depot", ["Office Supplies", "Office Supplies"]),
      ],
      departmentId: DEPT,
      aiCategory: "Repairs & Maintenance",
      aiConfidence: 0.9,
    });

    expect(suggestion).toMatchObject({ category: "Repairs & Maintenance", source: "ai" });
  });

  it("matches store numbers to the same merchant", () => {
    expect(normalizeVendorKey("CHIPOTLE #1234")).toBe("chipotle");
    expect(normalizeVendorKey("Chipotle 1234")).toBe("chipotle");

    const result = buildVendorCategoryHistory({
      vendor: "Chipotle Mexican Grill",
      expenses: history("CHIPOTLE #1234", ["Food", "Food"]),
      departmentId: DEPT,
    });

    expect(result.topCategory).toBe("Food");
    expect(result.total).toBe(2);
  });

  it("keeps genuinely different vendors apart", () => {
    const result = buildVendorCategoryHistory({
      vendor: "Home Goods",
      expenses: history("Home Depot", ["Equipment", "Equipment"]),
      departmentId: DEPT,
    });

    expect(result.total).toBe(0);
  });
});

describe("history boundaries", () => {
  it("never reads another department's transactions", () => {
    const suggestion = suggestExpenseCategory({
      vendor: "Chipotle",
      allowedCategories: ALLOWED,
      expenses: history("Chipotle", ["Fuel", "Fuel", "Fuel"], { department_id: OTHER_DEPT }),
      departmentId: DEPT,
    });

    expect(suggestion?.category).not.toBe("Fuel");
    expect(
      buildVendorCategoryHistory({
        vendor: "Chipotle",
        expenses: history("Chipotle", ["Fuel", "Fuel"], { department_id: OTHER_DEPT }),
        departmentId: DEPT,
      }).total,
    ).toBe(0);
  });

  it("does not learn a mapping from Uncategorized records", () => {
    const result = buildVendorCategoryHistory({
      vendor: "Acme Supply",
      expenses: [
        ...history("Acme Supply", ["Uncategorized", "Uncategorized", "Uncategorized"]),
        ...history("Acme Supply", [""]),
      ],
      departmentId: DEPT,
    });

    expect(result.total).toBe(0);
    expect(result.topCategory).toBeNull();
  });

  it("ignores transfers and deposits", () => {
    const result = buildVendorCategoryHistory({
      vendor: "Main Street Bank",
      expenses: history("Main Street Bank", ["Miscellaneous", "Miscellaneous"], {
        description: "Online transfer to savings",
      }),
      departmentId: DEPT,
    });

    expect(result.total).toBe(0);
  });
});

describe("an explicit vendor mapping wins", () => {
  it("uses the department's saved default category", () => {
    const vendors: DepartmentVendor[] = [
      {
        id: "v1",
        department_id: DEPT,
        name: "Chipotle",
        normalized_name: "chipotle",
        default_category: "Meeting Food",
        created_from: "manual",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ];

    const suggestion = suggestExpenseCategory({
      vendor: "CHIPOTLE #1234",
      allowedCategories: ALLOWED,
      expenses: history("Chipotle", ["Food", "Food", "Food"]),
      departmentId: DEPT,
      departmentVendors: vendors,
      aiCategory: "Food",
      aiConfidence: 0.95,
    });

    expect(suggestion).toMatchObject({ category: "Meeting Food", source: "vendor_default" });
  });
});

describe("Plaid metadata is one more signal", () => {
  it("contributes when history and vendor mapping are silent", () => {
    const suggestion = suggestExpenseCategory({
      vendor: "SHELL OIL 9912",
      allowedCategories: ALLOWED,
      expenses: [],
      departmentId: DEPT,
      plaidCategory: "Fuel",
      plaidMerchant: "Shell",
    });

    expect(suggestion).toMatchObject({ category: "Fuel", source: "plaid" });
  });

  it("loses to a strong department pattern", () => {
    const suggestion = suggestExpenseCategory({
      vendor: "Shell",
      allowedCategories: ALLOWED,
      expenses: history("Shell", ["Equipment", "Equipment", "Equipment"]),
      departmentId: DEPT,
      plaidCategory: "Fuel",
    });

    expect(suggestion).toMatchObject({ category: "Equipment", source: "history" });
  });
});

describe("when classification cannot help", () => {
  it("returns nothing rather than guessing", () => {
    const suggestion = suggestExpenseCategory({
      vendor: "Zzyzx Holdings LLC",
      allowedCategories: ALLOWED,
      expenses: [],
      departmentId: DEPT,
      aiCategory: null,
      aiConfidence: null,
    });

    expect(suggestion).toBeNull();
  });

  it("ignores a low-confidence model answer", () => {
    const suggestion = suggestExpenseCategory({
      vendor: "Zzyzx Holdings LLC",
      allowedCategories: ALLOWED,
      expenses: [],
      departmentId: DEPT,
      aiCategory: "Training",
      aiConfidence: 0.1,
    });

    expect(suggestion).toBeNull();
  });

  it("survives malformed history without throwing", () => {
    expect(() =>
      suggestExpenseCategory({
        vendor: "Chipotle",
        allowedCategories: ALLOWED,
        expenses: [expense({ payee: null, merchant_name: null, category: "Food" })],
        departmentId: DEPT,
      }),
    ).not.toThrow();
  });
});

describe("the user's choice is final", () => {
  const suggestion = { category: "Food", source: "ai", confidence: 0.94 } as const;

  it("shows the hint while the suggested value is untouched", () => {
    expect(
      isSuggestionVisible({ suggestion, currentCategory: "Food", userEdited: false }),
    ).toBe(true);
  });

  it("drops the hint once the user edits the field", () => {
    expect(
      isSuggestionVisible({ suggestion, currentCategory: "Fuel", userEdited: true }),
    ).toBe(false);
    // Even if they happen to type the same value back.
    expect(
      isSuggestionVisible({ suggestion, currentCategory: "Food", userEdited: true }),
    ).toBe(false);
  });

  it("drops the hint when the value no longer matches the suggestion", () => {
    expect(
      isSuggestionVisible({ suggestion, currentCategory: "Fuel", userEdited: false }),
    ).toBe(false);
  });

  it("discards a late response from a superseded upload", () => {
    // The user uploaded again (or cancelled) while request 1 was in flight.
    expect(shouldApplyExtractionResult(1, 2)).toBe(false);
    expect(shouldApplyExtractionResult(2, 2)).toBe(true);
  });
});

describe("manual entry keeps its existing behavior", () => {
  it("still suggests from vendor history without any receipt context", () => {
    expect(
      suggestCategory({
        vendor: "Chipotle",
        expenses: history("Chipotle", ["Food", "Food"]),
      }),
    ).toBe("Food");
  });

  it("still returns null when nothing matches", () => {
    expect(suggestCategory({ vendor: "Zzyzx Holdings LLC", expenses: [] })).toBeNull();
  });
});

describe("2% fund recommendations", () => {
  const twoPctCategories = [
    categoryRow({ name: "Meeting Food", normalized_name: "meeting food" }),
    categoryRow({
      name: "Food",
      normalized_name: "food",
      category_group: "general",
      two_percent_guidance: "not_two_percent",
    }),
  ];

  it("suggests 2% when the department usually pays this vendor that way", () => {
    const suggestion = suggestTwoPercentFunds({
      vendor: "Village Deli",
      category: "Food",
      expenses: history("Village Deli", ["Food", "Food", "Food"], {
        uses_two_percent_funds: true,
      }),
      departmentId: DEPT,
      departmentCategories: twoPctCategories,
      hasTwoPercentAccount: true,
    });

    expect(suggestion?.suggested).toBe(true);
  });

  it("stays silent when similar purchases use the operating account", () => {
    const suggestion = suggestTwoPercentFunds({
      vendor: "Village Deli",
      category: "Food",
      expenses: history("Village Deli", ["Food", "Food", "Food"], {
        uses_two_percent_funds: false,
      }),
      departmentId: DEPT,
      departmentCategories: twoPctCategories,
      hasTwoPercentAccount: true,
    });

    expect(suggestion).toBeNull();
  });

  it("never fires when the department has no 2% account", () => {
    const suggestion = suggestTwoPercentFunds({
      vendor: "Village Deli",
      category: "Meeting Food",
      expenses: [],
      departmentId: DEPT,
      departmentCategories: twoPctCategories,
      hasTwoPercentAccount: false,
    });

    expect(suggestion).toBeNull();
  });

  it("is a recommendation only — it never assigns the account itself", () => {
    const suggestion = suggestTwoPercentFunds({
      vendor: "Village Deli",
      category: "Meeting Food",
      expenses: [],
      departmentId: DEPT,
      departmentCategories: twoPctCategories,
      hasTwoPercentAccount: true,
    });

    expect(suggestion).toMatchObject({ suggested: true });
    // The shape carries no account or fund field to apply automatically.
    expect(Object.keys(suggestion || {}).sort()).toEqual(["confidence", "reason", "suggested"]);
  });

  it("ignores a hesitant model answer", () => {
    const suggestion = suggestTwoPercentFunds({
      vendor: "Zzyzx Holdings LLC",
      category: "Miscellaneous",
      expenses: [],
      departmentId: DEPT,
      departmentCategories: twoPctCategories,
      hasTwoPercentAccount: true,
      aiSuggestsTwoPercent: true,
      aiConfidence: 0.3,
    });

    expect(suggestion).toBeNull();
  });

  it("does not nag when the account is already a 2% account", () => {
    const suggestion = suggestTwoPercentFunds({
      vendor: "Village Deli",
      category: "Meeting Food",
      expenses: [],
      departmentId: DEPT,
      departmentCategories: twoPctCategories,
      hasTwoPercentAccount: true,
      alreadyTwoPercent: true,
    });

    expect(suggestion).toBeNull();
  });
});
