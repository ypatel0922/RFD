/**
 * Money In must not change the expense workflow: its categories stay out of
 * the expense picker, and payers, refunds and transfers never shape expense
 * category suggestions.
 */

import { describe, expect, it } from "vitest";

import { buildCategoryOptions } from "../categories";
import { buildVendorCategoryHistory } from "../category-suggestion";
import type { DepartmentCategory, ExpenseRecord } from "../types";
import { MONEY_IN_SEED_SOURCE } from "./categories";

const DEPT = "dept-a";

function category(overrides: Partial<DepartmentCategory>): DepartmentCategory {
  const name = overrides.name ?? "Fuel";
  return {
    id: `cat-${name}`,
    department_id: DEPT,
    name,
    normalized_name: name.toLowerCase(),
    description: null,
    category_group: "general",
    default_type: "expense",
    two_percent_guidance: "allowed",
    is_system_default: true,
    is_active: true,
    created_from: "seed",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as DepartmentCategory;
}

function row(overrides: Partial<ExpenseRecord>): ExpenseRecord {
  return {
    id: Math.random().toString(36).slice(2),
    department_id: DEPT,
    transaction_date: "2026-02-01",
    created_at: "2026-02-01T00:00:00Z",
    total_amount: 100,
    payee: "Firehouse Supply Co",
    merchant_name: "Firehouse Supply Co",
    category: "Equipment",
    ...overrides,
  } as ExpenseRecord;
}

describe("expense workflow is unchanged", () => {
  it("keeps Money In source categories out of the expense category picker", () => {
    const categories = [
      category({ name: "Fuel" }),
      category({ name: "Grant", default_type: "income", created_from: MONEY_IN_SEED_SOURCE }),
      category({ name: "Hall / Facility Rental", default_type: "income", created_from: MONEY_IN_SEED_SOURCE }),
    ];
    const options = buildCategoryOptions([], categories);
    expect(options).toContain("Fuel");
    expect(options).not.toContain("Grant");
    expect(options).not.toContain("Hall / Facility Rental");
  });

  it("does not add categories from Money In rows to the expense picker", () => {
    const options = buildCategoryOptions(
      [row({ category: "Donations Received", transaction_type: "income", total_amount: -50 })],
      [category({ name: "Fuel" })],
    );
    expect(options).not.toContain("Donations Received");
  });

  it("ignores refunds and transfers when learning a vendor's expense category", () => {
    const history = buildVendorCategoryHistory({
      vendor: "Firehouse Supply Co",
      departmentId: DEPT,
      expenses: [
        row({ category: "Equipment" }),
        row({ category: "Refund", transaction_type: "refund", total_amount: -40 }),
        row({ category: "Refund", transaction_type: "refund", total_amount: -40 }),
      ],
    });
    expect(history.topCategory).toBe("Equipment");
    expect(history.total).toBe(1);
  });
});
