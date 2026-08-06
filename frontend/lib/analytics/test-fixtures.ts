/**
 * Builders for analytics tests.
 *
 * Every field has a neutral default so a test only states the thing it is
 * actually about.
 */

import { normalizeCategoryKey } from "./budgets";
import type {
  AnalyticsBankAccountRow,
  AnalyticsExpenseRow,
  AnalyticsExternalAccountRow,
  AnalyticsExternalTransactionRow,
  AnalyticsOpeningBalanceRow,
  DepartmentAnalyticsSettings,
  DepartmentBudgetRow,
} from "./types";

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

export function makeExpense(
  overrides: Partial<AnalyticsExpenseRow> = {},
): AnalyticsExpenseRow {
  return {
    id: nextId("expense"),
    transaction_date: "2025-06-15",
    created_at: "2025-06-15T12:00:00Z",
    total_amount: "100.00",
    category: "Equipment",
    payee: "Firehouse Supply Co",
    merchant_name: null,
    description: "Nozzle replacement",
    fund: null,
    payment_reference: null,
    payment_method: "debit_card",
    bank_account_name: "Operating Checking",
    receipt_path: "dept/2025/06/expense/receipt.jpg",
    original_filename: "receipt.jpg",
    extraction_status: "extracted",
    extraction_notes: null,
    reconciliation_status: "matched",
    reconciled_at: "2025-06-20T12:00:00Z",
    reconciliation_candidate: false,
    uses_two_percent_funds: false,
    two_percent_review_status: null,
    ...overrides,
  };
}

export function makeBankAccount(
  overrides: Partial<AnalyticsBankAccountRow> = {},
): AnalyticsBankAccountRow {
  return {
    id: nextId("account"),
    name: "Operating Checking",
    institution_name: "Community Bank",
    account_mask: "1234",
    account_type: "Checking",
    fund_type: "operating",
    is_two_percent_account: false,
    is_default: true,
    last_reconciled_at: null,
    last_reconciled_ending_balance: null,
    ...overrides,
  };
}

export function makeExternalTransaction(
  overrides: Partial<AnalyticsExternalTransactionRow> = {},
): AnalyticsExternalTransactionRow {
  return {
    id: nextId("external"),
    external_account_id: "ext-account-1",
    posted_date: "2025-06-15",
    description: "FIREHOUSE SUPPLY CO",
    amount: "100.00",
    pending: false,
    expense_id: null,
    match_status: "unmatched",
    ...overrides,
  };
}

export function makeExternalAccount(
  overrides: Partial<AnalyticsExternalAccountRow> = {},
): AnalyticsExternalAccountRow {
  return {
    id: "ext-account-1",
    name: "Operating Checking",
    mask: "1234",
    type: "depository",
    subtype: "checking",
    ...overrides,
  };
}

export function makeOpeningBalance(
  overrides: Partial<AnalyticsOpeningBalanceRow> = {},
): AnalyticsOpeningBalanceRow {
  return {
    account_id: null,
    account_name: "Operating Checking",
    account_type: "Checking",
    beginning_balance: "10000.00",
    balance_date: "2024-12-31",
    ...overrides,
  };
}

/**
 * The normalized key is derived from the category so overriding one field
 * cannot leave a fixture whose key silently fails to match any spending.
 */
export function makeBudget(
  overrides: Partial<DepartmentBudgetRow> = {},
): DepartmentBudgetRow {
  const category = overrides.category ?? "Equipment";
  return {
    id: nextId("budget"),
    department_id: "dept-1",
    fiscal_year: 2025,
    category,
    normalized_category: normalizeCategoryKey(category),
    amount: "5000.00",
    notes: null,
    ...overrides,
  };
}

export function makeSettings(
  overrides: Partial<DepartmentAnalyticsSettings> = {},
): DepartmentAnalyticsSettings {
  return {
    department_id: "dept-1",
    two_percent_target_percent: 80,
    two_percent_basis: "total_available",
    fiscal_year_start_month: 1,
    ...overrides,
  };
}
