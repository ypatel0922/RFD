/**
 * Incoming bank activity (Plaid credits) and how it meets Money In records.
 *
 * Plaid signs amounts from the account's point of view: positive is money
 * leaving, negative is money arriving. Everything here works in whole cents.
 *
 * The rules that keep every dollar counted once:
 *  - a bank credit is only offered against an inflow record, never an expense;
 *  - amounts must match to the cent and dates must sit in a deposit window;
 *  - a record that already names a deposit account only matches that account;
 *  - transfer pairs are only offered when the pairing is unambiguous (1:1);
 *  - a posted row replaces its pending row instead of adding a second copy.
 */

import { absCents, parseCents } from "../reconciliation/money";
import type { ExpenseRecord } from "../types";
import { isTypedMoneyInRow } from "./categories";
import { normalizeCounterpartyName } from "./record";

export type BankActivityRow = {
  id: string;
  external_transaction_id: string;
  external_account_id: string | null;
  posted_date: string | null;
  description: string | null;
  amount: number | string | null;
  pending: boolean | null;
  expense_id: string | null;
  match_status: string | null;
  pending_transaction_id?: string | null;
};

export type BankAccountRef = { id: string; name: string; mask?: string | null };

const DAY_MS = 86_400_000;

function toMillis(iso: string | null | undefined): number | null {
  const day = (iso || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Signed bank cents; negative means money arrived. */
export function bankSignedCents(row: Pick<BankActivityRow, "amount">): number | null {
  return parseCents(row.amount);
}

/** A bank row still waiting for someone to say what it is. */
export function isOpenBankRow(row: BankActivityRow): boolean {
  if (row.expense_id) return false;
  const status = (row.match_status || "unmatched").toLowerCase();
  return status !== "superseded" && status !== "matched" && status !== "ignored";
}

export function isOpenBankCredit(row: BankActivityRow): boolean {
  const cents = bankSignedCents(row);
  return cents != null && cents < 0 && isOpenBankRow(row);
}

export type BankCreditKind = "transfer" | "interest" | "refund" | "income";

/** A first guess from the bank description; the user always confirms. */
export function classifyBankCredit(description: string | null | undefined): BankCreditKind {
  const text = (description || "").toLowerCase();
  if (/\b(transfer|xfer|trnsfr|online banking transfer|from (sav|chk|checking|savings))\b/.test(text)) return "transfer";
  if (/\binterest\b|\bint pd\b|\bdividend\b/.test(text)) return "interest";
  if (/\brefund\b|\breturn(ed)?\b|\breversal\b|\bcredit adj/.test(text)) return "refund";
  return "income";
}

export type MoneyInBankMatch = {
  record: ExpenseRecord;
  score: number;
  reasons: string[];
};

const MATCH_WINDOW_BEFORE_DAYS = 3;
const MATCH_WINDOW_AFTER_DAYS = 14;
export const BANK_MATCH_MIN_SCORE = 0.5;

/** Money In records (income or refund) that can still take a bank match. */
export function isMatchableMoneyInRecord(row: ExpenseRecord): boolean {
  if (!isTypedMoneyInRow(row)) return false;
  if (row.transaction_type === "transfer") return false;
  if (row.reconciliation_status === "matched") return false;
  if (row.bank_transaction_id) return false;
  return true;
}

function significantTokens(value: string | null | undefined): string[] {
  return normalizeCounterpartyName(value)
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !["fire", "dept", "department", "company", "inc", "llc", "check", "deposit"].includes(t));
}

/**
 * Score how well a bank credit fits a Money In record. Returns null when it
 * can never be the same money (direction, amount, account, or date window).
 */
export function scoreMoneyInBankMatch(
  credit: BankActivityRow,
  record: ExpenseRecord,
  options: { accountsById?: Map<string, BankAccountRef> } = {},
): MoneyInBankMatch | null {
  if (!isOpenBankCredit(credit) || !isMatchableMoneyInRecord(record)) return null;
  const creditCents = bankSignedCents(credit);
  const recordCents = parseCents(record.total_amount);
  if (creditCents == null || recordCents == null || recordCents >= 0) return null;
  if (absCents(creditCents) !== absCents(recordCents)) return null;

  const reasons: string[] = ["Same amount"];
  let score = 0.4;

  const creditAccount = credit.external_account_id ? options.accountsById?.get(credit.external_account_id) : undefined;
  const recordAccount = (record.bank_account_name || "").trim().toLowerCase();
  if (creditAccount && recordAccount) {
    if (creditAccount.name.trim().toLowerCase() !== recordAccount) return null;
    score += 0.15;
    reasons.push("Same account");
  }

  const creditMillis = toMillis(credit.posted_date);
  const anchorMillis = toMillis(record.deposit_date) ?? toMillis(record.transaction_date);
  if (creditMillis != null && anchorMillis != null) {
    const days = (creditMillis - anchorMillis) / DAY_MS;
    if (days < -MATCH_WINDOW_BEFORE_DAYS || days > MATCH_WINDOW_AFTER_DAYS) return null;
    score += days >= 0 && days <= 5 ? 0.25 : 0.1;
    reasons.push(days === 0 ? "Same day" : `${Math.abs(Math.round(days))} day${Math.abs(Math.round(days)) === 1 ? "" : "s"} apart`);
  }

  const description = (credit.description || "").toLowerCase();
  const payerTokens = significantTokens(record.payee || record.merchant_name);
  if (payerTokens.length && payerTokens.some((token) => description.includes(token))) {
    score += 0.15;
    reasons.push("Payer named on deposit");
  }
  const checkNumber = (record.payment_reference || "").trim();
  if (checkNumber && new RegExp(`\\b0*${checkNumber.replace(/[^0-9a-z]/gi, "")}\\b`, "i").test(description)) {
    score += 0.15;
    reasons.push(`Check #${checkNumber}`);
  }
  if (credit.pending) reasons.push("Bank shows pending");

  return { record, score: Math.min(1, score), reasons };
}

/** Best candidates first; only ones worth showing. */
export function findMoneyInBankMatches(
  credit: BankActivityRow,
  records: ExpenseRecord[],
  options: { accountsById?: Map<string, BankAccountRef>; departmentId?: string } = {},
): MoneyInBankMatch[] {
  const matches: MoneyInBankMatch[] = [];
  for (const record of records) {
    if (options.departmentId && record.department_id && record.department_id !== options.departmentId) continue;
    const match = scoreMoneyInBankMatch(credit, record, options);
    if (match && match.score >= BANK_MATCH_MIN_SCORE) matches.push(match);
  }
  return matches.sort((a, b) => b.score - a.score);
}

export type TransferPair = { credit: BankActivityRow; debit: BankActivityRow };

const TRANSFER_WINDOW_DAYS = 3;

function couldBeTransferPair(credit: BankActivityRow, debit: BankActivityRow): boolean {
  if (credit.id === debit.id) return false;
  if (!isOpenBankRow(credit) || !isOpenBankRow(debit)) return false;
  const c = bankSignedCents(credit);
  const d = bankSignedCents(debit);
  if (c == null || d == null || c >= 0 || d <= 0) return false;
  if (absCents(c) !== absCents(d)) return false;
  if (!credit.external_account_id || !debit.external_account_id) return false;
  if (credit.external_account_id === debit.external_account_id) return false;
  const cm = toMillis(credit.posted_date);
  const dm = toMillis(debit.posted_date);
  if (cm == null || dm == null) return false;
  return Math.abs(cm - dm) / DAY_MS <= TRANSFER_WINDOW_DAYS;
}

/**
 * A credit and a debit between two of the department's own accounts.
 * Only offered when each side has exactly one possible partner, so an
 * ambiguous pair is never presented as a transfer.
 */
export function findTransferPair(credit: BankActivityRow, rows: BankActivityRow[]): TransferPair | null {
  const debits = rows.filter((row) => couldBeTransferPair(credit, row));
  if (debits.length !== 1) return null;
  const debit = debits[0];
  const creditsForDebit = rows.filter((row) => couldBeTransferPair(row, debit));
  if (creditsForDebit.length !== 1) return null;
  return { credit, debit };
}

export type PendingSupersession = {
  postedExternalId: string;
  pendingRowId: string;
  inheritExpenseId: string | null;
  inheritMatchStatus: string | null;
};

/**
 * When Plaid posts a transaction it sends a new id and points back at the
 * pending one. The posted row takes over any link the pending row had, and
 * the pending row is marked superseded so it is never counted again.
 */
export function planPendingSupersession(
  added: Array<{ transaction_id: string; pending_transaction_id?: string | null; pending?: boolean | null }>,
  existingByExternalId: Map<string, Pick<BankActivityRow, "id" | "expense_id" | "match_status">>,
): PendingSupersession[] {
  const plans: PendingSupersession[] = [];
  for (const tx of added) {
    if (tx.pending || !tx.pending_transaction_id) continue;
    const previous = existingByExternalId.get(tx.pending_transaction_id);
    if (!previous) continue;
    plans.push({
      postedExternalId: tx.transaction_id,
      pendingRowId: previous.id,
      inheritExpenseId: previous.expense_id ?? null,
      inheritMatchStatus: previous.expense_id ? previous.match_status || "matched" : null,
    });
  }
  return plans;
}

/**
 * Whether the sync route may auto-match a bank row to an existing ledger row.
 * Outflows only meet ordinary (untyped or expense) outflows; incoming money is
 * never auto-matched — it is surfaced for review instead.
 */
export function canAutoMatchBankRow(
  bankAmount: number,
  candidate: { total_amount: number | string | null; transaction_type?: string | null },
): boolean {
  if (!(bankAmount > 0)) return false;
  const type = candidate.transaction_type ?? null;
  if (type && type !== "expense") return false;
  const cents = parseCents(candidate.total_amount);
  return cents != null && cents > 0;
}

/** Bank context carried into the Money In form when recording from a credit. */
export function bankCreditPrefill(credit: BankActivityRow, account: BankAccountRef | undefined) {
  const cents = bankSignedCents(credit) ?? 0;
  return {
    date: (credit.posted_date || "").slice(0, 10),
    amountCents: absCents(cents),
    depositAccount: account?.name ?? "",
    memo: credit.description ?? "",
    bank: {
      externalRowId: credit.id,
      externalTransactionId: credit.external_transaction_id,
      postedDate: credit.posted_date,
      description: credit.description,
      amountCents: absCents(cents),
    },
  };
}
