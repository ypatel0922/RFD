/**
 * Source / payer history: everything a department has received from one
 * source. Computed from the department's own ledger rows only, so another
 * department's donors or payments can never appear.
 */

import { normalizeVendorKey } from "../category-suggestion";
import { absCents, parseCents } from "../reconciliation/money";
import type { ExpenseRecord } from "../types";
import { moneyInCategoryConfig } from "./categories";
import { isMoneyInHistoryRow } from "./suggestion";

type SourceRow = Pick<
  ExpenseRecord,
  | "id"
  | "department_id"
  | "payee"
  | "merchant_name"
  | "category"
  | "total_amount"
  | "fund"
  | "transaction_type"
  | "transaction_date"
  | "created_at"
  | "uses_two_percent_funds"
>;

export type SourceHistoryItem = {
  id: string;
  date: string;
  amountCents: number;
  category: string | null;
};

export type SourceHistory = {
  name: string;
  lifetimeCents: number;
  count: number;
  firstDate: string | null;
  lastDate: string | null;
  recent: SourceHistoryItem[];
  /** True when any gift from this source was recorded as a donation. */
  isDonor: boolean;
  /** Wording for the totals line: donors give, other sources pay. */
  totalLabel: "Lifetime donations" | "Lifetime received";
};

function rowDate(row: SourceRow): string {
  return (row.transaction_date || row.created_at || "").slice(0, 10);
}

export function buildSourceHistory(params: {
  name: string | null | undefined;
  ledgerRows: SourceRow[];
  departmentId: string;
  excludeId?: string;
  recentLimit?: number;
}): SourceHistory | null {
  const key = normalizeVendorKey(params.name);
  if (!key) return null;
  const rows = params.ledgerRows
    .filter(
      (row) =>
        row.department_id === params.departmentId &&
        row.id !== params.excludeId &&
        // Refunds are money back, not support from a source.
        row.transaction_type !== "refund" &&
        isMoneyInHistoryRow(row) &&
        normalizeVendorKey(row.payee || row.merchant_name) === key,
    )
    .sort((a, b) => rowDate(b).localeCompare(rowDate(a)));
  if (!rows.length) return null;

  let lifetime = 0;
  let isDonor = false;
  for (const row of rows) {
    lifetime += absCents(parseCents(row.total_amount) ?? 0);
    if (moneyInCategoryConfig(row.category)?.donor || /donat/i.test(row.category || "")) isDonor = true;
  }
  const dates = rows.map(rowDate).filter(Boolean);
  return {
    name: (params.name || "").trim(),
    lifetimeCents: lifetime,
    count: rows.length,
    firstDate: dates.length ? dates[dates.length - 1] : null,
    lastDate: dates.length ? dates[0] : null,
    recent: rows.slice(0, params.recentLimit ?? 5).map((row) => ({
      id: row.id,
      date: rowDate(row),
      amountCents: absCents(parseCents(row.total_amount) ?? 0),
      category: row.category,
    })),
    isDonor,
    totalLabel: isDonor ? "Lifetime donations" : "Lifetime received",
  };
}
