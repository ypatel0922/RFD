/**
 * Turns raw department records into the one transaction shape every analytics
 * calculation reads.
 *
 * This module is the single place that decides what a transaction *is*. It
 * deliberately builds on the direction rule the rest of Hallix already uses
 * (`isLedgerInflow` from the reconciliation ledger) rather than inventing a
 * second opinion about what counts as income, and layers the distinctions
 * analytics additionally needs on top of it:
 *
 *   - internal transfers between two department accounts
 *   - credit card payments, which settle a liability rather than spend money
 *   - refunds, which give money back and so reduce expenses
 *
 * Getting these wrong inflates both sides of the ledger. Moving $5,000 from
 * savings to checking is not $5,000 of income and $5,000 of spending, and
 * paying off a card is not a second purchase on top of the purchases already
 * charged to it.
 */

import { absCents, parseCents, type Cents } from "../reconciliation/money";
import { isLedgerInflow } from "../reconciliation/ledger";
import { isIsoDate, toUtcMillis, type IsoDate } from "../reconciliation/dates";
import { normalizeAccountName } from "./accounts";
import type {
  AnalyticsExpenseRow,
  AnalyticsExternalTransactionRow,
  AnalyticsTransaction,
  ClassifiedAccount,
  FundDesignation,
  TransactionClass,
} from "./types";

// ─── Text rules ───────────────────────────────────────────────────────────────

/** Wording that means money moved between two accounts the department owns. */
const TRANSFER_PATTERNS = [
  /\binternal\s+transfer\b/,
  /\bfunds?\s+transfer\b/,
  /\btransfer\s+(?:to|from|between)\b/,
  /\bacct\s+transfer\b/,
  /\bxfer\b/,
  /\bonline\s+transfer\b/,
  /\bbook\s+transfer\b/,
];

/** Wording that means a credit card balance was paid down. */
const CARD_PAYMENT_PATTERNS = [
  /\bcredit\s*card\s*payment\b/,
  /\bcard\s*payment\b/,
  /\bcc\s*payment\b/,
  /\bpayment\s*(?:to|toward|towards)\s*(?:the\s*)?(?:credit\s*)?card\b/,
  /\bpayment\s*[-–—]\s*thank\s*you\b/,
  /\bautopay\b/,
  /\bstatement\s*payment\b/,
];

/** Wording that means a vendor gave money back. */
const REFUND_PATTERNS = [
  /\brefund(?:ed|s)?\b/,
  /\breturn(?:ed)?\s+(?:merchandise|item|purchase|goods)\b/,
  /\bmerchandise\s+return\b/,
  /\brebate\b/,
  /\breimburse(?:ment|d)?\b/,
  /\bchargeback\b/,
  /\bcredit\s+memo\b/,
  /\bcredit\s+adjustment\b/,
  /\bvoided?\s+(?:charge|purchase)\b/,
];

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Whether an expense row has a real receipt attached.
 *
 * Mirrors the placeholder-path rule already used when Hallix decides to ask a
 * member for a missing receipt. It is reimplemented here rather than imported
 * because that helper lives in a server-only module, and analytics runs in the
 * browser. The predicate is intentionally identical.
 */
export function rowHasReceipt(row: {
  receipt_path: string | null;
  original_filename: string | null;
}): boolean {
  const path = (row.receipt_path ?? "").toLowerCase();
  if (!path) return false;
  if (path.includes("no-receipt")) return false;
  if (path.includes("/manual/")) return false;
  if (path.includes("/statement-import/")) return false;
  if ((row.original_filename ?? "").toLowerCase() === "manual-entry") return false;
  return true;
}

/**
 * Whether a ledger row was typed in by a member or created from an imported
 * bank statement. Statement-import rows store their placeholder receipt under
 * a `/statement-import/` path, which is the only durable marker on the row.
 */
function rowOrigin(row: AnalyticsExpenseRow): "manual" | "imported" {
  return (row.receipt_path ?? "").toLowerCase().includes("/statement-import/")
    ? "imported"
    : "manual";
}

function isoDateOf(row: AnalyticsExpenseRow): IsoDate | null {
  const transaction = (row.transaction_date ?? "").trim().slice(0, 10);
  if (isIsoDate(transaction)) return transaction;
  const created = (row.created_at ?? "").trim().slice(0, 10);
  return isIsoDate(created) ? created : null;
}

function vendorOf(row: AnalyticsExpenseRow): string | null {
  return row.payee?.trim() || row.merchant_name?.trim() || null;
}

// ─── Classification ───────────────────────────────────────────────────────────

export type ClassificationResult = {
  classification: TransactionClass;
  reason: string;
};

/**
 * Decide what a single ledger row represents.
 *
 * `accountLookup` maps a normalized account name to a classified account, so a
 * row whose payee is literally another department account can be recognized as
 * a transfer without any name guessing about what the account *means*.
 */
export function classifyExpenseRow(
  row: AnalyticsExpenseRow,
  accountLookup: Map<string, ClassifiedAccount>,
): ClassificationResult {
  const inflow = isLedgerInflow(row);
  const ownAccount = accountLookup.get(normalizeAccountName(row.bank_account_name));
  const text = [row.category, row.payee, row.merchant_name, row.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const counterparty = findCounterpartyAccount(row, accountLookup, ownAccount);
  if (counterparty) {
    if (counterparty.kind === "liability" && !inflow) {
      return {
        classification: "credit_card_payment",
        reason: `Paid to ${counterparty.name}, a liability account, so it settles a balance rather than spending new money.`,
      };
    }
    return {
      classification: "internal_transfer",
      reason: `Both sides are department accounts (${ownAccount?.name ?? "this account"} and ${counterparty.name}), so it moves money rather than earning or spending it.`,
    };
  }

  if (matchesAny(CARD_PAYMENT_PATTERNS, text)) {
    return {
      classification: "credit_card_payment",
      reason: "Described as a credit card payment, so the purchases already charged to the card are not counted twice.",
    };
  }

  if (matchesAny(TRANSFER_PATTERNS, text)) {
    return {
      classification: "internal_transfer",
      reason: "Described as a transfer between accounts, so it is excluded from income and expenses.",
    };
  }

  if (inflow) {
    if (matchesAny(REFUND_PATTERNS, text)) {
      return {
        classification: "refund",
        reason: "Money returned by a vendor, so it reduces spending instead of counting as income.",
      };
    }
    return { classification: "income", reason: "Money received into a department account." };
  }

  if (ownAccount?.kind === "liability") {
    return {
      classification: "expense",
      reason: `Purchase charged to ${ownAccount.name}. Card purchases count as spending when they are charged.`,
    };
  }

  return { classification: "expense", reason: "Money paid out of a department account." };
}

/**
 * Find the department account on the other side of a transaction.
 *
 * Only an exact normalized-name match counts. A partial match would misread a
 * vendor called "Cash Express" as the department's "Cash" account.
 */
function findCounterpartyAccount(
  row: AnalyticsExpenseRow,
  accountLookup: Map<string, ClassifiedAccount>,
  ownAccount: ClassifiedAccount | undefined,
): ClassifiedAccount | null {
  for (const candidate of [row.payee, row.merchant_name]) {
    const key = normalizeAccountName(candidate);
    if (!key) continue;
    const account = accountLookup.get(key);
    if (account && account.id !== ownAccount?.id) return account;
  }
  return null;
}

// ─── Normalization ────────────────────────────────────────────────────────────

function fundOf(
  row: AnalyticsExpenseRow,
  account: ClassifiedAccount | undefined,
): FundDesignation {
  if (row.uses_two_percent_funds) return "two_percent";
  return account?.fund ?? "unspecified";
}

/**
 * A transaction is treated as 2% money when the treasurer tagged it, or when
 * it sits in an account the department designated as a 2% account. Both are
 * explicit records, never inferred from an account or category name.
 */
function isTwoPercentRow(
  row: AnalyticsExpenseRow,
  account: ClassifiedAccount | undefined,
): boolean {
  return Boolean(row.uses_two_percent_funds) || Boolean(account?.isTwoPercent);
}

export function normalizeExpenseRow(
  row: AnalyticsExpenseRow,
  accountLookup: Map<string, ClassifiedAccount>,
): AnalyticsTransaction {
  const account = accountLookup.get(normalizeAccountName(row.bank_account_name));
  const { classification, reason } = classifyExpenseRow(row, accountLookup);
  const cents = parseCents(row.total_amount);
  const magnitude = cents == null ? 0 : absCents(cents);
  const inflow = classification === "income" || classification === "refund";

  return {
    id: row.id,
    date: isoDateOf(row),
    signedCents: cents == null ? null : inflow ? magnitude : -magnitude,
    magnitudeCents: magnitude,
    classification,
    classificationReason: reason,
    // Ledger rows are the department's own record of what happened. Plaid
    // pending state lives on the imported row, not here.
    status: "posted",
    origin: rowOrigin(row),
    vendor: vendorOf(row),
    category: row.category?.trim() || null,
    accountName: row.bank_account_name?.trim() || null,
    accountId: account?.id ?? null,
    fund: fundOf(row, account),
    isTwoPercent: isTwoPercentRow(row, account),
    hasReceipt: rowHasReceipt(row),
    isReconciled: row.reconciliation_status === "matched",
    reconciledAt: row.reconciled_at,
    isFlaggedDuplicate: Boolean(row.reconciliation_candidate),
    hasDescription: Boolean((row.description ?? "").trim()),
    twoPercentReviewStatus: row.two_percent_review_status,
    description: row.description,
  };
}

// ─── Imported bank activity ───────────────────────────────────────────────────

export type ImportedActivity = {
  /** Pending bank rows. Never included in finalized totals. */
  pending: AnalyticsExternalTransactionRow[];
  /** Posted bank rows with no matching ledger entry yet. */
  unmatched: AnalyticsExternalTransactionRow[];
  /** Posted bank rows already represented by a ledger entry. */
  matchedExpenseIds: Set<string>;
};

function normalizedDescription(value: string | null): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Split imported bank rows into what analytics may show and what it must
 * ignore.
 *
 * Rows already linked to a ledger entry are dropped, because the ledger entry
 * is the record analytics counts — including both would double every matched
 * transaction. A pending row is dropped when a posted row for the same account,
 * amount and description appears within a few days, which is what a Plaid
 * transaction looks like as it settles.
 */
export function splitImportedActivity(
  rows: AnalyticsExternalTransactionRow[],
): ImportedActivity {
  const matchedExpenseIds = new Set<string>();
  const pendingCandidates: AnalyticsExternalTransactionRow[] = [];
  const posted: AnalyticsExternalTransactionRow[] = [];

  for (const row of rows) {
    if (row.expense_id) {
      matchedExpenseIds.add(row.expense_id);
      continue;
    }
    if (row.pending) pendingCandidates.push(row);
    else posted.push(row);
  }

  const pending = pendingCandidates.filter((candidate) => !hasPostedTwin(candidate, posted));

  return { pending, unmatched: posted, matchedExpenseIds };
}

const SETTLEMENT_WINDOW_DAYS = 5;

function hasPostedTwin(
  pendingRow: AnalyticsExternalTransactionRow,
  posted: AnalyticsExternalTransactionRow[],
): boolean {
  const pendingCents = parseCents(pendingRow.amount);
  const pendingDescription = normalizedDescription(pendingRow.description);
  const pendingMillis = toUtcMillis((pendingRow.posted_date ?? "").slice(0, 10));

  return posted.some((candidate) => {
    if (candidate.external_account_id !== pendingRow.external_account_id) return false;
    const candidateCents = parseCents(candidate.amount);
    if (pendingCents == null || candidateCents == null) return false;
    if (absCents(pendingCents) !== absCents(candidateCents)) return false;
    if (normalizedDescription(candidate.description) !== pendingDescription) return false;

    const candidateMillis = toUtcMillis((candidate.posted_date ?? "").slice(0, 10));
    if (pendingMillis == null || candidateMillis == null) return true;
    const days = Math.abs(candidateMillis - pendingMillis) / 86_400_000;
    return days <= SETTLEMENT_WINDOW_DAYS;
  });
}

export function sumPendingCents(rows: AnalyticsExternalTransactionRow[]): Cents {
  let total = 0;
  for (const row of rows) {
    const cents = parseCents(row.amount);
    if (cents != null) total += absCents(cents);
  }
  return total;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export type NormalizedLedger = {
  transactions: AnalyticsTransaction[];
  imported: ImportedActivity;
};

export function normalizeLedger(input: {
  expenses: AnalyticsExpenseRow[];
  externalTransactions?: AnalyticsExternalTransactionRow[];
  accounts: ClassifiedAccount[];
}): NormalizedLedger {
  const lookup = new Map<string, ClassifiedAccount>();
  for (const account of input.accounts) {
    if (account.normalizedName) lookup.set(account.normalizedName, account);
  }

  return {
    transactions: input.expenses.map((row) => normalizeExpenseRow(row, lookup)),
    imported: splitImportedActivity(input.externalTransactions ?? []),
  };
}

// ─── Totals ───────────────────────────────────────────────────────────────────

/** Transactions that belong in income and expense totals. */
export function isOperatingTransaction(transaction: AnalyticsTransaction): boolean {
  return (
    transaction.classification === "income" ||
    transaction.classification === "expense" ||
    transaction.classification === "refund"
  );
}

export function isSpendTransaction(transaction: AnalyticsTransaction): boolean {
  return transaction.classification === "expense";
}
