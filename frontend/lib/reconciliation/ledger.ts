/**
 * Bridge between the Hallix ledger and the bank's sign convention.
 *
 * Hallix keeps one transaction table (`expenses`) for both directions:
 *   - a spend is stored as a positive `total_amount`
 *   - money received is stored as a negative `total_amount`, or as a positive
 *     amount carrying an income category/fund
 *
 * The bank statement uses the opposite sense (a deposit is a credit, positive).
 * `ledgerSignedCents` is the only place that translation happens, so matching,
 * validation and display all share one convention.
 */

import { normalizeCheckNumber, normalizeDescription, normalizeReferenceNumber } from "./description";
import { absCents, parseCents, type Cents } from "./money";
import { isIsoDate, type IsoDate } from "./dates";
import type { LedgerCandidate } from "./types";

/** The subset of `expenses` columns reconciliation needs. */
export type LedgerExpenseRow = {
  id: string;
  transaction_date: string | null;
  total_amount: string | number | null;
  payee: string | null;
  merchant_name: string | null;
  description: string | null;
  category: string | null;
  fund: string | null;
  payment_reference: string | null;
  bank_account_name: string | null;
  reconciliation_status: string | null;
  reconciled_at: string | null;
};

/**
 * Whether a ledger row represents money coming in.
 *
 * Mirrors the display rule already used by the Transactions ledger and the NYS
 * 2% report so the reconciliation screen never disagrees with the rest of the
 * app about a transaction's direction.
 */
export function isLedgerInflow(row: {
  total_amount: string | number | null;
  category: string | null;
  fund: string | null;
}): boolean {
  const cents = parseCents(row.total_amount);
  if (cents != null && cents < 0) return true;

  const category = (row.category || "").toLowerCase();
  if (
    category.includes("income") ||
    category.includes("deposit") ||
    category.includes("revenue") ||
    category.includes("interest")
  ) {
    return true;
  }

  const fund = (row.fund || "").toLowerCase();
  if (fund.includes("deposit") || fund.includes("income") || fund.includes("revenue")) return true;

  return false;
}

/**
 * The ledger amount in bank convention: positive for a deposit, negative for a
 * withdrawal. Returns null when the stored amount cannot be read.
 */
export function ledgerSignedCents(row: {
  total_amount: string | number | null;
  category: string | null;
  fund: string | null;
}): Cents | null {
  const cents = parseCents(row.total_amount);
  if (cents == null) return null;
  const magnitude = absCents(cents);
  return isLedgerInflow(row) ? magnitude : -magnitude;
}

/** Best available human name for a ledger row. */
export function ledgerVendorName(row: {
  payee: string | null;
  merchant_name: string | null;
  description: string | null;
}): string | null {
  return row.payee?.trim() || row.merchant_name?.trim() || row.description?.trim() || null;
}

/**
 * Distinct normalized name needles for matching. Each of payee, merchant and
 * memo is scored on its own so a long receipt description cannot poison
 * containment, and a cardholder-style payee cannot hide the real merchant.
 */
export function ledgerMatchNames(row: {
  payee: string | null;
  merchant_name: string | null;
  description: string | null;
}): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of [row.payee, row.merchant_name, row.description]) {
    const normalized = normalizeDescription(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    names.push(normalized);
  }
  return names;
}

function normalizedDate(value: string | null): IsoDate | null {
  if (!value) return null;
  const trimmed = value.trim().slice(0, 10);
  return isIsoDate(trimmed) ? trimmed : null;
}

/** Turn an `expenses` row into the shape the matcher consumes. */
export function toLedgerCandidate(row: LedgerExpenseRow): LedgerCandidate {
  const vendor = ledgerVendorName(row);
  const matchNames = ledgerMatchNames(row);
  // Joined form kept for display/debug; matching scores matchNames individually.
  const normalizedText = matchNames.join(" ") || normalizeDescription(vendor);

  return {
    expenseId: row.id,
    date: normalizedDate(row.transaction_date),
    signedAmountCents: ledgerSignedCents(row),
    vendor,
    description: row.description,
    matchNames,
    normalizedText,
    checkNumber: normalizeCheckNumber(checkNumberFromLedger(row)),
    referenceNumber: normalizeReferenceNumber(row.payment_reference),
    bankAccountName: row.bank_account_name,
    category: row.category,
    isAlreadyReconciled: row.reconciliation_status === "matched" && Boolean(row.reconciled_at),
  };
}

/**
 * A Hallix check number lives in `payment_reference`, which also holds card auth
 * codes and invoice numbers. Only treat it as a check number when it is a short
 * run of digits, optionally prefixed with check wording.
 */
function checkNumberFromLedger(row: { payment_reference: string | null }): string | null {
  const raw = row.payment_reference?.trim();
  if (!raw) return null;
  const labelled = raw.match(/(?:check|cheque|chk|ck)\s*(?:number|num|no|nbr|#)?\s*[:#]?\s*(\d{1,8})/i);
  if (labelled) return labelled[1];
  if (/^#?\s*\d{1,8}$/.test(raw)) return raw.replace(/\D/g, "");
  return null;
}

/** Amount to prefill when creating a Hallix transaction from a statement line. */
export function statementAmountToLedgerAmount(signedAmountCents: Cents): number {
  // Flip back into Hallix's sense: a bank debit becomes a positive expense.
  return -signedAmountCents / 100;
}
