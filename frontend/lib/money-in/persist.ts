/**
 * Browser-side writes for Money In. Everything goes through the user's
 * Supabase session, so RLS keeps every row inside the caller's department.
 */

import { supabase } from "../supabase";
import type { DepartmentCounterparty, ExtractedMoneyInData } from "../types";
import { FALLBACK_MONEY_IN_EXTRACTION_CLIENT } from "./extraction-fallback";
import { normalizeCounterpartyName } from "./record";
import { moneyInCategoryConfig } from "./categories";

function missingColumnFromSchemaError(message: string) {
  const match = message.match(/Could not find the '([^']+)' column/i);
  return match?.[1] || null;
}

/**
 * Insert ledger rows, dropping columns the database does not have yet (for
 * example before migration 024 is applied). The rows still save with their
 * negative amount, which every screen already reads as money in.
 */
export async function insertLedgerRows(rows: Record<string, unknown>[]) {
  let payload = rows.map((row) => ({ ...row }));
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await supabase.from("expenses").insert(payload);
    if (!result.error) return result;
    const missing = missingColumnFromSchemaError(result.error.message);
    if (!missing || !payload.some((row) => missing in row)) return result;
    payload = payload.map((row) => {
      const next = { ...row };
      delete next[missing];
      return next;
    });
  }
  return supabase.from("expenses").insert(payload);
}

/** Update one department ledger row with the same missing-column tolerance. */
export async function updateLedgerRow(id: string, departmentId: string, patch: Record<string, unknown>) {
  let payload = { ...patch };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await supabase.from("expenses").update(payload).eq("id", id).eq("department_id", departmentId);
    if (!result.error) return result;
    const missing = missingColumnFromSchemaError(result.error.message);
    if (!missing || !(missing in payload)) return result;
    delete payload[missing];
  }
  return supabase.from("expenses").update(payload).eq("id", id).eq("department_id", departmentId);
}

export async function loadCounterparties(departmentId: string): Promise<DepartmentCounterparty[]> {
  try {
    const { data, error } = await supabase
      .from("department_counterparties")
      .select("*")
      .eq("department_id", departmentId)
      .order("name");
    if (error) return [];
    return (data || []) as DepartmentCounterparty[];
  } catch {
    return [];
  }
}

function kindForCategory(category: string): DepartmentCounterparty["kind"] {
  const config = moneyInCategoryConfig(category);
  if (config?.donor) return "donor";
  if (config?.key === "grant") return "grantor";
  if (config?.key === "government" || config?.twoPercent) return "government";
  return "payer";
}

/**
 * Find or create the department's source / payer record. Best effort: a
 * missing table or a race never blocks recording the money.
 */
export async function ensureCounterparty(params: {
  departmentId: string;
  name: string;
  category: string;
  existing: DepartmentCounterparty[];
}): Promise<string | null> {
  const normalized = normalizeCounterpartyName(params.name);
  if (!normalized) return null;
  const known = params.existing.find((c) => c.department_id === params.departmentId && c.normalized_name === normalized);
  if (known) return known.id;
  try {
    const { data, error } = await supabase
      .from("department_counterparties")
      .insert({
        department_id: params.departmentId,
        name: params.name.trim(),
        normalized_name: normalized,
        kind: kindForCategory(params.category),
        default_category: params.category.trim() || null,
        created_from: "money_in",
      })
      .select("id")
      .single();
    if (!error && data) return (data as { id: string }).id;
    const { data: row } = await supabase
      .from("department_counterparties")
      .select("id")
      .eq("department_id", params.departmentId)
      .eq("normalized_name", normalized)
      .maybeSingle();
    return (row as { id: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

/** Link a bank row to the ledger record that represents it, so it counts once. */
export async function linkExternalTransaction(params: {
  departmentId: string;
  externalRowId: string;
  expenseId: string;
}) {
  return supabase
    .from("external_transactions")
    .update({ expense_id: params.expenseId, match_status: "matched", match_confidence: 1 })
    .eq("id", params.externalRowId)
    .eq("department_id", params.departmentId);
}

/** Read a check or payment document via the authenticated extraction route. */
export async function extractMoneyInDocument(params: {
  file: File;
  departmentId: string;
  accessToken: string;
  allowedCategories: string[];
}): Promise<ExtractedMoneyInData> {
  const form = new FormData();
  form.append("document", params.file);
  form.append("department_id", params.departmentId);
  if (params.allowedCategories.length) form.append("categories", JSON.stringify(params.allowedCategories));
  try {
    const response = await fetch("/api/extract-money-in", {
      method: "POST",
      headers: { Authorization: `Bearer ${params.accessToken}` },
      body: form,
    });
    if (!response.ok) return FALLBACK_MONEY_IN_EXTRACTION_CLIENT;
    return (await response.json()) as ExtractedMoneyInData;
  } catch {
    return FALLBACK_MONEY_IN_EXTRACTION_CLIENT;
  }
}
