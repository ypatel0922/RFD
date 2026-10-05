/**
 * Turns a confirmed Money In form into canonical ledger rows.
 *
 * Money In lives on the same `expenses` ledger as everything else. Incoming
 * money is stored the way bank-statement deposits already are — a negative
 * `total_amount` — and carries an explicit `transaction_type` so analytics
 * never has to guess:
 *
 *   income   → counts as Money In
 *   refund   → nets against spend, never counted as income
 *   transfer → two linked legs between department accounts; balances only
 */

import { centsToNumeric } from "../reconciliation/money";
import type {
  ExpenseRecord,
  ExtractedMoneyInData,
  MoneyInDepositStatus,
  MoneyInDetails,
  MoneyInDocumentType,
} from "../types";
import { moneyInTransactionType } from "./categories";
import { sanitizeCheckNumber, stripBankNumbers } from "./sensitive";

export type MoneyInMode = "money_in" | "transfer";

export type MoneyInFormValues = {
  mode: MoneyInMode;
  /** Date the money was received (or the transfer date). */
  date_received: string;
  payer: string;
  /** Integer cents, always positive. */
  amount_cents: number;
  /** Destination account. */
  deposit_account: string;
  /** Transfer source account. */
  transfer_from_account: string;
  category: string;
  uses_two_percent_funds: boolean;
  check_number: string;
  deposit_status: MoneyInDepositStatus;
  deposit_date: string;
  payment_method: string;
  memo: string;
  fund: string;
  donor_note: string;
  grant_reference: string;
  restriction: string;
  related_expense_id: string;
};

export function emptyMoneyInForm(overrides: Partial<MoneyInFormValues> = {}): MoneyInFormValues {
  return {
    mode: "money_in",
    date_received: "",
    payer: "",
    amount_cents: 0,
    deposit_account: "",
    transfer_from_account: "",
    category: "",
    uses_two_percent_funds: false,
    check_number: "",
    deposit_status: "deposited",
    deposit_date: "",
    payment_method: "",
    memo: "",
    fund: "",
    donor_note: "",
    grant_reference: "",
    restriction: "",
    related_expense_id: "",
    ...overrides,
  };
}

export const MONEY_IN_PAYMENT_METHODS = [
  { value: "check", label: "Check" },
  { value: "cash", label: "Cash" },
  { value: "ach", label: "ACH / Direct deposit" },
  { value: "wire", label: "Wire" },
  { value: "card", label: "Card / online payment" },
  { value: "other", label: "Other" },
] as const;

/** A check in hand has usually not hit the bank yet. */
export function defaultDepositStatus(paymentMethod: string, documentType?: MoneyInDocumentType | null): MoneyInDepositStatus {
  if (documentType === "deposit_slip") return "deposited";
  if (paymentMethod === "check" || paymentMethod === "cash" || documentType === "check") return "received";
  return "deposited";
}

export type MoneyInValidationError = { field: "date" | "payer" | "amount" | "account" | "from_account" | "category"; message: string };

export function validateMoneyIn(values: MoneyInFormValues, options: { hasBankAccounts: boolean }): MoneyInValidationError | null {
  if (!values.date_received) return { field: "date", message: "Add the date the money was received." };
  if (values.mode === "money_in" && !values.payer.trim()) return { field: "payer", message: "Add who the money came from." };
  if (!Number.isInteger(values.amount_cents) || values.amount_cents <= 0) {
    return { field: "amount", message: "Enter an amount greater than $0.00." };
  }
  if (options.hasBankAccounts && !values.deposit_account.trim()) {
    return { field: "account", message: "Choose the account this money goes into." };
  }
  if (values.mode === "transfer") {
    if (!values.transfer_from_account.trim()) return { field: "from_account", message: "Choose the account the money came from." };
    if (values.transfer_from_account.trim().toLowerCase() === values.deposit_account.trim().toLowerCase()) {
      return { field: "from_account", message: "A transfer needs two different accounts." };
    }
    return null;
  }
  if (!values.category.trim()) return { field: "category", message: "Choose a source / category." };
  return null;
}

export type MoneyInDocument = {
  receiptId: string;
  path: string;
  filename: string;
  contentType: string;
  documentType: MoneyInDocumentType | null;
};

export type MoneyInActor = { id: string; email: string; label: string };

/**
 * Storage path for a check or payment document. Lives in the private
 * `receipts` bucket, under the department folder that storage RLS checks.
 */
export function buildMoneyInDocumentPath(params: {
  departmentId: string;
  expenseId: string;
  documentId: string;
  extension: string;
  now?: Date;
}): string {
  const now = params.now ?? new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const ext = params.extension.startsWith(".") ? params.extension : `.${params.extension}`;
  return `${params.departmentId}/money-in/${year}/${month}/${params.expenseId}/${params.documentId}${ext}`;
}

function optional(value: string | null | undefined): string | null {
  const trimmed = (value || "").trim();
  return trimmed || null;
}

/** Negative ledger amount for money coming in, as numeric(12,2). */
function inflowAmount(cents: number): number {
  return centsToNumeric(-Math.abs(cents)) as number;
}

function outflowAmount(cents: number): number {
  return centsToNumeric(Math.abs(cents)) as number;
}

export type MoneyInSuggestionAudit = {
  suggestedCategory: string | null;
  suggestedCategorySource: string | null;
  twoPercentSuggested: boolean;
};

export function buildMoneyInLedgerRow(params: {
  id: string;
  departmentId: string;
  values: MoneyInFormValues;
  actor: MoneyInActor;
  document?: MoneyInDocument | null;
  extraction?: ExtractedMoneyInData | null;
  counterpartyId?: string | null;
  suggestion?: MoneyInSuggestionAudit | null;
  /** Bank row this record is created from (already the bank's copy). */
  bankMatch?: { externalTransactionId: string; postedDate: string | null; description: string | null; amountCents: number } | null;
  now?: Date;
}): Record<string, unknown> {
  const { values, actor, document, extraction, suggestion, bankMatch } = params;
  const now = (params.now ?? new Date()).toISOString();
  const relatedExpenseId = optional(values.related_expense_id);
  const transactionType = moneyInTransactionType(values.category, { relatedExpenseId });
  const isTwoPct = transactionType === "income" && values.uses_two_percent_funds;
  const category = optional(values.category);

  const details: MoneyInDetails = {
    document_type: document?.documentType ?? extraction?.document_type ?? null,
    donor_note: stripBankNumbers(values.donor_note),
    grant_reference: optional(values.grant_reference),
    restriction: stripBankNumbers(values.restriction),
    suggested_category: suggestion?.suggestedCategory ?? null,
    suggested_category_source: suggestion?.suggestedCategorySource ?? null,
    category_overridden: suggestion?.suggestedCategory
      ? (suggestion.suggestedCategory || "").trim().toLowerCase() !== (category || "").toLowerCase()
      : null,
    two_percent_suggested: suggestion?.twoPercentSuggested ?? null,
    two_percent_confirmed: isTwoPct,
  };

  return {
    id: params.id,
    department_id: params.departmentId,
    transaction_type: transactionType,
    receipt_id: document?.receiptId ?? params.id,
    receipt_path: document?.path ?? `${params.departmentId}/manual/${params.id}/no-receipt`,
    original_filename: document?.filename ?? "manual-entry",
    content_type: document?.contentType ?? "text/plain",
    created_at: now,
    created_by_user_id: actor.id,
    created_by_email: actor.email,
    uploaded_by: actor.label,
    transaction_date: values.date_received,
    payee: optional(values.payer),
    merchant_name: optional(values.payer),
    total_amount: inflowAmount(values.amount_cents),
    category,
    bank_account_name: optional(values.deposit_account),
    payment_method: optional(values.payment_method),
    payment_reference: sanitizeCheckNumber(values.check_number),
    description: stripBankNumbers(values.memo),
    fund: optional(values.fund),
    counterparty_id: params.counterpartyId ?? null,
    related_expense_id: transactionType === "refund" ? relatedExpenseId : null,
    deposit_status: bankMatch ? "deposited" : values.deposit_status,
    deposit_date:
      optional(values.deposit_date) ??
      (bankMatch?.postedDate || (values.deposit_status === "deposited" ? values.date_received : null)),
    money_in_details: details,
    uses_two_percent_funds: isTwoPct,
    extraction_status: document ? extraction?.extraction_status ?? "needs_review" : "needs_review",
    extraction_confidence: extraction?.confidence ?? 0,
    extraction_notes: document ? extraction?.notes ?? null : "Manual Money In entry",
    bank_match_confidence: bankMatch ? 1 : 0,
    ...(bankMatch
      ? {
          reconciliation_status: "matched",
          bank_transaction_id: bankMatch.externalTransactionId,
          bank_posted_date: bankMatch.postedDate,
          bank_description: bankMatch.description,
          bank_amount: centsToNumeric(-Math.abs(bankMatch.amountCents)),
          reconciled_at: now,
        }
      : { reconciliation_status: "pending_bank_match" }),
  };
}

/**
 * An internal transfer is two linked legs: money out of one department account
 * and the same money into another. Both are typed `transfer`, so neither ever
 * counts as income or spend.
 */
export function buildTransferLedgerRows(params: {
  outId: string;
  inId: string;
  groupId: string;
  departmentId: string;
  values: MoneyInFormValues;
  actor: MoneyInActor;
  /** Bank rows each leg was confirmed from, when the pair came from the feed. */
  bankLegs?: { out?: TransferBankLeg | null; in?: TransferBankLeg | null };
  now?: Date;
}): [Record<string, unknown>, Record<string, unknown>] {
  const { values, actor } = params;
  const now = (params.now ?? new Date()).toISOString();
  const from = values.transfer_from_account.trim();
  const to = values.deposit_account.trim();
  const memo = stripBankNumbers(values.memo);
  const base = {
    department_id: params.departmentId,
    transaction_type: "transfer",
    transfer_group_id: params.groupId,
    original_filename: "manual-entry",
    content_type: "text/plain",
    created_at: now,
    created_by_user_id: actor.id,
    created_by_email: actor.email,
    uploaded_by: actor.label,
    transaction_date: values.date_received,
    category: null,
    payment_method: optional(values.payment_method),
    payment_reference: sanitizeCheckNumber(values.check_number),
    uses_two_percent_funds: false,
    extraction_status: "needs_review",
    extraction_confidence: 0,
    extraction_notes: "Internal transfer",
    reconciliation_status: "pending_bank_match",
    bank_match_confidence: 0,
  };
  const outLeg = {
    ...base,
    id: params.outId,
    receipt_id: params.outId,
    receipt_path: `${params.departmentId}/manual/${params.outId}/no-receipt`,
    payee: to,
    merchant_name: to,
    bank_account_name: from,
    transfer_account_name: to,
    total_amount: outflowAmount(values.amount_cents),
    description: memo ?? `Transfer to ${to}`,
  };
  const inLeg = {
    ...base,
    id: params.inId,
    receipt_id: params.inId,
    receipt_path: `${params.departmentId}/manual/${params.inId}/no-receipt`,
    payee: from,
    merchant_name: from,
    bank_account_name: to,
    transfer_account_name: from,
    total_amount: inflowAmount(values.amount_cents),
    description: memo ?? `Transfer from ${from}`,
  };
  return [
    { ...outLeg, ...transferBankFields(params.bankLegs?.out, 1, now) },
    { ...inLeg, ...transferBankFields(params.bankLegs?.in, -1, now) },
  ];
}

export type TransferBankLeg = {
  externalTransactionId: string;
  postedDate: string | null;
  description: string | null;
  amountCents: number;
};

function transferBankFields(leg: TransferBankLeg | null | undefined, sign: 1 | -1, now: string) {
  if (!leg) return {};
  return {
    reconciliation_status: "matched",
    bank_transaction_id: leg.externalTransactionId,
    bank_posted_date: leg.postedDate,
    bank_description: leg.description,
    bank_amount: centsToNumeric(sign * Math.abs(leg.amountCents)),
    bank_match_confidence: 1,
    reconciled_at: now,
  };
}

export type MoneyInStatusKey = "awaiting_deposit" | "deposited" | "awaiting_bank_match" | "matched";

export const MONEY_IN_STATUS_LABELS: Record<MoneyInStatusKey, string> = {
  awaiting_deposit: "Awaiting deposit",
  deposited: "Deposited",
  awaiting_bank_match: "Awaiting bank match",
  matched: "Matched",
};

/**
 * Lifecycle badge for an incoming record. Departments with a bank feed see
 * "Awaiting bank match" after deposit; departments without one see
 * "Deposited" until a statement reconciliation matches it.
 */
export function moneyInStatus(
  row: Pick<ExpenseRecord, "reconciliation_status" | "deposit_status">,
  options: { hasBankFeed: boolean },
): { key: MoneyInStatusKey; label: string } {
  let key: MoneyInStatusKey;
  if (row.reconciliation_status === "matched") key = "matched";
  else if (row.deposit_status === "received") key = "awaiting_deposit";
  else key = options.hasBankFeed ? "awaiting_bank_match" : "deposited";
  return { key, label: MONEY_IN_STATUS_LABELS[key] };
}

/** Update applied by "Mark as deposited". */
export function markDepositedPatch(params: { depositAccount: string; depositDate: string }): Record<string, unknown> {
  return {
    deposit_status: "deposited",
    deposit_date: params.depositDate,
    bank_account_name: params.depositAccount,
  };
}

/** Normalized payer name used for the department_counterparties unique key. */
export function normalizeCounterpartyName(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
}
