"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";

import { supabase } from "../lib/supabase";
import type { ExpenseRecord } from "../lib/types";

const LEDGER_ALL_LIMIT = 5000;

type QuickFilter =
  | "all"
  | "needs_review"
  | "reconciled"
  | "income"
  | "expenses"
  | "missing_receipt"
  | "two_percent"
  | "this_month";

type StatusKey =
  | "reconciled"
  | "matched"
  | "needs_review"
  | "missing_receipt"
  | "pending_bank_match"
  | "extracted";

type StatusInfo = { label: string; key: StatusKey };

function formatLocalYMD(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function expenseNumericAmount(total: ExpenseRecord["total_amount"]): number | null {
  if (total == null) return null;
  if (typeof total === "number") return Number.isNaN(total) ? null : total;
  const trimmed = String(total).replace(/[$,]/g, "").trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isNaN(n) ? null : n;
}

function optionalValue(value: string) {
  const trimmed = value.trim();
  return trimmed || null;
}

function optionalNumber(value: string) {
  const normalized = String(value).replace(/[$,]/g, "").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseExpenseSortDate(expense: ExpenseRecord): string {
  const td = expense.transaction_date?.trim();
  if (td && /^\d{4}-\d{2}-\d{2}/.test(td)) return td.slice(0, 10);
  const c = expense.created_at?.slice(0, 10);
  if (c && /^\d{4}-\d{2}-\d{2}/.test(c)) return c;
  return "";
}

function formatHumanDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const raw = iso.trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return raw;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Math.abs(amount));
}

function formatExpenseLoggedBy(expense: ExpenseRecord) {
  const raw = expense.uploaded_by?.trim();
  if (raw) return raw;
  return expense.created_by_email || "Unknown";
}

function vendorName(expense: ExpenseRecord) {
  return expense.payee || expense.merchant_name || "Needs review";
}

function isIncomeTransaction(expense: ExpenseRecord) {
  const amount = expenseNumericAmount(expense.total_amount);
  const category = (expense.category || "").toLowerCase();
  if (category.includes("income")) return true;
  if (amount != null && amount < 0) return true;
  const fund = (expense.fund || "").toLowerCase();
  if (fund.includes("2%") || fund.includes("deposit")) return true;
  return false;
}

function formatTransactionAmount(expense: ExpenseRecord) {
  const amount = expenseNumericAmount(expense.total_amount);
  if (amount == null) return { text: "—", className: "transactions-amount-muted" };
  if (isIncomeTransaction(expense)) {
    return { text: `+${formatCurrency(Math.abs(amount))}`, className: "transactions-amount-income" };
  }
  return { text: `-${formatCurrency(Math.abs(amount))}`, className: "transactions-amount-expense" };
}

function isMissingReceipt(expense: ExpenseRecord, receiptUrls: Record<string, string>) {
  if (expense.receipt_path?.includes("no-receipt")) return true;
  if (expense.original_filename === "manual-entry" && !receiptUrls[expense.id]) return true;
  return !receiptUrls[expense.id] && expense.extraction_notes?.toLowerCase().includes("without receipt");
}

function isTwoPercentFund(expense: ExpenseRecord) {
  if (expense.uses_two_percent_funds) return true;
  const fund = (expense.fund || "").toLowerCase();
  const category = (expense.category || "").toLowerCase();
  const payee = vendorName(expense).toLowerCase();
  return fund.includes("2%") || category.includes("2%") || payee.includes("2%");
}

function isInCurrentMonth(iso: string) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return false;
  const now = new Date();
  const [y, m] = iso.slice(0, 10).split("-");
  return Number(y) === now.getFullYear() && Number(m) === now.getMonth() + 1;
}

function transactionStatus(expense: ExpenseRecord, receiptUrls: Record<string, string>): StatusInfo {
  if (
    expense.extraction_status === "needs_review" ||
    expense.extraction_status === "failed" ||
    expense.reconciliation_status === "needs_attention"
  ) {
    return { label: "Needs Review", key: "needs_review" };
  }
  if (isMissingReceipt(expense, receiptUrls)) {
    return { label: "Missing Receipt", key: "missing_receipt" };
  }
  if (expense.reconciliation_status === "matched") {
    return { label: "Reconciled", key: "reconciled" };
  }
  if (expense.reconciliation_candidate) {
    return { label: "Matched", key: "matched" };
  }
  if (expense.reconciliation_status === "pending_bank_match") {
    return { label: "Pending Bank Match", key: "pending_bank_match" };
  }
  if (expense.extraction_status === "extracted") {
    return { label: "Extracted", key: "extracted" };
  }
  if (expense.reconciliation_status === "unreconciled") {
    return { label: "Needs Review", key: "needs_review" };
  }
  return { label: "Needs Review", key: "needs_review" };
}

function categoryPillClass(category: string | null | undefined) {
  const c = (category || "").toLowerCase();
  if (!c || c.includes("uncategor")) return "transactions-cat-gray";
  if (c.includes("income")) return "transactions-cat-green";
  if (c.includes("ppe") || c.includes("uniform") || c.includes("equipment")) return "transactions-cat-purple";
  if (c.includes("supply") || c.includes("office")) return "transactions-cat-blue";
  if (c.includes("food") || c.includes("feed")) return "transactions-cat-orange";
  if (c.includes("train")) return "transactions-cat-amber";
  if (c.includes("travel") || c.includes("fuel") || c.includes("gas")) return "transactions-cat-slate";
  return "transactions-cat-gray";
}

function categoryLabel(expense: ExpenseRecord) {
  return expense.category || expense.description || "Uncategorized";
}

function canPreviewReceipt(expense: ExpenseRecord, url: string | undefined) {
  if (!url) return false;
  if (expense.content_type?.startsWith("image/")) return true;
  return /\.(jpe?g|png|gif|webp)(\?|$)/i.test(url);
}

const TWO_PERCENT_STATUS_LABELS: Record<string, string> = {
  likely_eligible: "Likely 2% Eligible",
  needs_review: "Needs Review",
  potentially_not_allowed: "Potentially Not Allowed",
};

const TWO_PERCENT_STATUS_CLASS: Record<string, string> = {
  likely_eligible: "fb-2pct-badge--eligible",
  needs_review: "fb-2pct-badge--review",
  potentially_not_allowed: "fb-2pct-badge--warn",
};

function TwoPercentTransactionBadges({ expense }: { expense: ExpenseRecord }) {
  const isTwoPct = isTwoPercentFund(expense);
  if (!isTwoPct) return null;
  const status = expense.two_percent_review_status;
  return (
    <span className="fb-2pct-tx-badges">
      <span className="fb-2pct-badge fb-2pct-badge--fund" title="NYS Foreign Fire Insurance / 2% Funds">
        2%
      </span>
      {status ? (
        <span
          className={`fb-2pct-badge ${TWO_PERCENT_STATUS_CLASS[status] ?? ""}`}
          title={TWO_PERCENT_STATUS_LABELS[status] ?? status}
        >
          {TWO_PERCENT_STATUS_LABELS[status] ?? status}
        </span>
      ) : null}
    </span>
  );
}

const QUICK_FILTERS: { id: QuickFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "needs_review", label: "Needs Review" },
  { id: "reconciled", label: "Reconciled" },
  { id: "income", label: "Income" },
  { id: "expenses", label: "Expenses" },
  { id: "missing_receipt", label: "Missing Receipt" },
  { id: "two_percent", label: "2% Funds" },
  { id: "this_month", label: "This Month" },
];

export function TransactionsLedger({
  expenses,
  receiptUrls,
  user,
  onExpensesChanged,
  showErrorMessage,
  showSuccessMessage,
  vendorQuery,
  onVendorQueryChange,
  ledgerMayTruncate,
  bankAccountFilter = "",
  onClearBankAccountFilter,
}: {
  expenses: ExpenseRecord[];
  receiptUrls: Record<string, string>;
  user: User;
  onExpensesChanged: () => Promise<void>;
  showErrorMessage: (message: string) => void;
  showSuccessMessage: (message: string | null) => void;
  vendorQuery: string;
  onVendorQueryChange: (value: string) => void;
  ledgerMayTruncate: boolean;
  bankAccountFilter?: string;
  onClearBankAccountFilter?: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editReason, setEditReason] = useState("");
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [categoryFilter, setCategoryFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const filtersRef = useRef<HTMLDivElement>(null);

  const selectedExpense = useMemo(
    () => expenses.find((e) => e.id === selectedId) ?? null,
    [expenses, selectedId],
  );

  useEffect(() => {
    function onDocClick(event: MouseEvent) {
      if (filtersRef.current && !filtersRef.current.contains(event.target as Node)) {
        setFiltersOpen(false);
      }
      const target = event.target as HTMLElement;
      if (!target.closest(".transactions-row-menu")) {
        setMenuOpenId(null);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setSelectedId(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  function applyDatePreset(preset: "ytd" | "last_year" | "last12" | "clear") {
    const now = new Date();
    if (preset === "clear") {
      setDateFrom("");
      setDateTo("");
      return;
    }
    if (preset === "ytd") {
      setDateFrom(formatLocalYMD(new Date(now.getFullYear(), 0, 1)));
      setDateTo(formatLocalYMD(now));
      return;
    }
    if (preset === "last_year") {
      const y = now.getFullYear() - 1;
      setDateFrom(formatLocalYMD(new Date(y, 0, 1)));
      setDateTo(formatLocalYMD(new Date(y, 11, 31)));
      return;
    }
    const start = new Date(now);
    start.setFullYear(start.getFullYear() - 1);
    setDateFrom(formatLocalYMD(start));
    setDateTo(formatLocalYMD(now));
  }

  const filteredExpenses = useMemo(() => {
    let list = expenses;
    const q = vendorQuery.trim().toLowerCase();
    if (q) {
      list = list.filter((expense) => {
        const payee = (expense.payee || expense.merchant_name || "").toLowerCase();
        const desc = (expense.description || "").toLowerCase();
        return payee.includes(q) || desc.includes(q);
      });
    }
    if (bankAccountFilter.trim()) {
      const b = bankAccountFilter.trim().toLowerCase();
      list = list.filter((expense) => (expense.bank_account_name || "").trim().toLowerCase() === b);
    }
    if (categoryFilter.trim()) {
      const c = categoryFilter.trim().toLowerCase();
      list = list.filter((expense) => (expense.category || "").toLowerCase().includes(c));
    }
    if (dateFrom) {
      list = list.filter((expense) => (expense.transaction_date || "") >= dateFrom);
    }
    if (dateTo) {
      list = list.filter((expense) => (expense.transaction_date || "") <= dateTo);
    }
    const min = optionalNumber(amountMin);
    const max = optionalNumber(amountMax);
    if (min != null) {
      list = list.filter((expense) => (expenseNumericAmount(expense.total_amount) ?? -Infinity) >= min);
    }
    if (max != null) {
      list = list.filter((expense) => (expenseNumericAmount(expense.total_amount) ?? Infinity) <= max);
    }

    switch (quickFilter) {
      case "needs_review":
        list = list.filter(
          (e) =>
            e.extraction_status === "needs_review" ||
            e.extraction_status === "failed" ||
            e.reconciliation_status === "needs_attention",
        );
        break;
      case "reconciled":
        list = list.filter((e) => e.reconciliation_status === "matched");
        break;
      case "income":
        list = list.filter(isIncomeTransaction);
        break;
      case "expenses":
        list = list.filter((e) => !isIncomeTransaction(e));
        break;
      case "missing_receipt":
        list = list.filter((e) => isMissingReceipt(e, receiptUrls));
        break;
      case "two_percent":
        list = list.filter(isTwoPercentFund);
        break;
      case "this_month":
        list = list.filter((e) => isInCurrentMonth(parseExpenseSortDate(e)));
        break;
      default:
        break;
    }
    return list;
  }, [
    expenses,
    vendorQuery,
    categoryFilter,
    dateFrom,
    dateTo,
    amountMin,
    amountMax,
    quickFilter,
    receiptUrls,
    bankAccountFilter,
  ]);

  const displayExpenses = useMemo(() => {
    const copy = [...filteredExpenses];
    copy.sort((a, b) => {
      const da = parseExpenseSortDate(a);
      const db = parseExpenseSortDate(b);
      if (da !== db) return db.localeCompare(da);
      return (b.created_at || "").localeCompare(a.created_at || "");
    });
    return copy;
  }, [filteredExpenses]);

  const metrics = useMemo(() => {
    const now = new Date();
    const monthStart = formatLocalYMD(new Date(now.getFullYear(), now.getMonth(), 1));
    const monthEnd = formatLocalYMD(now);

    let needsReview = 0;
    let monthSpent = 0;
    let monthIncome = 0;

    for (const expense of expenses) {
      const status = transactionStatus(expense, receiptUrls);
      if (status.key === "needs_review") needsReview += 1;

      const iso = parseExpenseSortDate(expense);
      if (iso < monthStart || iso > monthEnd) continue;
      const amount = expenseNumericAmount(expense.total_amount);
      if (amount == null) continue;
      if (isIncomeTransaction(expense)) {
        monthIncome += Math.abs(amount);
      } else {
        monthSpent += Math.abs(amount);
      }
    }

    return {
      total: expenses.length,
      needsReview,
      monthSpent,
      monthIncome,
    };
  }, [expenses, receiptUrls]);

  const similarTransactions = useMemo(() => {
    if (!selectedExpense) return [];
    const name = vendorName(selectedExpense).toLowerCase();
    if (!name || name === "needs review") return [];
    return expenses
      .filter((e) => e.id !== selectedExpense.id && vendorName(e).toLowerCase() === name)
      .sort((a, b) => parseExpenseSortDate(b).localeCompare(parseExpenseSortDate(a)))
      .slice(0, 5);
  }, [expenses, selectedExpense]);

  function beginEdit(expense: ExpenseRecord) {
    setEditingId(expense.id);
    setEditReason("");
    setEditValues({
      payee: expense.payee || expense.merchant_name || "",
      total_amount: expense.total_amount == null ? "" : String(expense.total_amount),
      transaction_date: expense.transaction_date || "",
      category: expense.category || "",
      bank_account_name: expense.bank_account_name || "",
      description: expense.description || "",
    });
    setMenuOpenId(null);
  }

  async function saveEdit(expenseId: string) {
    if (!editReason.trim()) {
      showErrorMessage("Enter a reason for manual edits.");
      return;
    }
    const { error } = await supabase
      .from("expenses")
      .update({
        payee: optionalValue(editValues.payee || ""),
        merchant_name: optionalValue(editValues.payee || ""),
        total_amount: optionalNumber(editValues.total_amount),
        transaction_date: optionalValue(editValues.transaction_date || ""),
        category: optionalValue(editValues.category || ""),
        bank_account_name: optionalValue(editValues.bank_account_name || ""),
        description: optionalValue(editValues.description || ""),
        last_manual_edit_reason: editReason.trim(),
        last_manual_edit_at: new Date().toISOString(),
        last_manual_edit_by: user.email || user.id,
      })
      .eq("id", expenseId);
    if (error) {
      showErrorMessage(error.message);
      return;
    }
    setEditingId(null);
    setEditReason("");
    showSuccessMessage("Expense updated.");
    await onExpensesChanged();
  }

  function clearFilters() {
    onVendorQueryChange("");
    setCategoryFilter("");
    setDateFrom("");
    setDateTo("");
    setAmountMin("");
    setAmountMax("");
    setQuickFilter("all");
    onClearBankAccountFilter?.();
  }

  const hasAdvancedFilters = Boolean(
    vendorQuery || categoryFilter || dateFrom || dateTo || amountMin || amountMax || bankAccountFilter,
  );

  function renderEditForm(expenseId: string, compact?: boolean) {
    return (
      <form
        className={`transactions-edit-form${compact ? " transactions-edit-form-compact" : ""}`}
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void saveEdit(expenseId);
        }}
      >
        <input
          placeholder="Vendor"
          value={editValues.payee || ""}
          onChange={(event) => setEditValues((prev) => ({ ...prev, payee: event.target.value }))}
        />
        <input
          placeholder="Amount"
          value={editValues.total_amount || ""}
          onChange={(event) => setEditValues((prev) => ({ ...prev, total_amount: event.target.value }))}
        />
        <input
          type="date"
          value={editValues.transaction_date || ""}
          onChange={(event) =>
            setEditValues((prev) => ({ ...prev, transaction_date: event.target.value }))
          }
        />
        <input
          placeholder="Category"
          value={editValues.category || ""}
          onChange={(event) => setEditValues((prev) => ({ ...prev, category: event.target.value }))}
        />
        <input
          placeholder="Bank account"
          value={editValues.bank_account_name || ""}
          onChange={(event) =>
            setEditValues((prev) => ({ ...prev, bank_account_name: event.target.value }))
          }
        />
        <textarea
          rows={2}
          placeholder="Reason for edit (required)"
          value={editReason}
          onChange={(event) => setEditReason(event.target.value)}
        />
        <div className="transactions-edit-actions">
          <button type="submit">Save edit</button>
          <button type="button" className="secondary-action" onClick={() => setEditingId(null)}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  function renderRowActions(expense: ExpenseRecord) {
    const receiptUrl = receiptUrls[expense.id];
    return (
      <div className="transactions-row-menu">
        <button
          type="button"
          className="transactions-menu-trigger"
          aria-label="Transaction actions"
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpenId(menuOpenId === expense.id ? null : expense.id);
          }}
        >
          ⋯
        </button>
        {menuOpenId === expense.id ? (
          <div className="transactions-menu-dropdown" role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={(event) => {
                event.stopPropagation();
                beginEdit(expense);
                setSelectedId(expense.id);
              }}
            >
              Edit transaction
            </button>
            {receiptUrl ? (
              <a
                href={receiptUrl}
                target="_blank"
                rel="noopener noreferrer"
                role="menuitem"
                onClick={(event) => event.stopPropagation()}
              >
                View receipt / source
              </a>
            ) : (
              <span className="transactions-menu-disabled" role="menuitem">
                No receipt on file
              </span>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  function renderDetailPanel() {
    if (!selectedExpense) return null;
    const receiptUrl = receiptUrls[selectedExpense.id];
    const amount = formatTransactionAmount(selectedExpense);
    const status = transactionStatus(selectedExpense, receiptUrls);
    const editing = editingId === selectedExpense.id;

    return (
      <>
        <button
          type="button"
          className="transactions-drawer-backdrop"
          aria-label="Close transaction details"
          onClick={() => setSelectedId(null)}
        />
        <aside className="transactions-drawer" role="dialog" aria-label="Transaction details">
          <div className="transactions-drawer-header">
            <h3>Transaction Details</h3>
            <button type="button" className="transactions-drawer-close" onClick={() => setSelectedId(null)}>
              ×
            </button>
          </div>

          <div className="transactions-drawer-body">
            {receiptUrl ? (
              <div className="transactions-receipt-preview">
                {canPreviewReceipt(selectedExpense, receiptUrl) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={receiptUrl} alt={`Receipt for ${vendorName(selectedExpense)}`} />
                ) : (
                  <div className="transactions-receipt-fallback">
                    <p className="muted">Receipt on file ({selectedExpense.original_filename})</p>
                    <a href={receiptUrl} target="_blank" rel="noopener noreferrer">
                      Open preview
                    </a>
                  </div>
                )}
              </div>
            ) : null}

            <dl className="transactions-detail-list">
              <div>
                <dt>Vendor</dt>
                <dd>{vendorName(selectedExpense)}</dd>
              </div>
              <div>
                <dt>Amount</dt>
                <dd className={amount.className}>{amount.text}</dd>
              </div>
              <div>
                <dt>Date</dt>
                <dd>{formatHumanDate(parseExpenseSortDate(selectedExpense))}</dd>
              </div>
              <div>
                <dt>Account</dt>
                <dd>{selectedExpense.bank_account_name || "—"}</dd>
              </div>
              <div>
                <dt>Category</dt>
                <dd>
                  <span className={`transactions-cat-pill ${categoryPillClass(selectedExpense.category)}`}>
                    {categoryLabel(selectedExpense)}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  <span className={`transactions-status-pill transactions-status-${status.key}`}>
                    {status.label}
                  </span>
                </dd>
              </div>
              {(selectedExpense.bank_description ||
                selectedExpense.reconciliation_candidate_notes ||
                selectedExpense.reconciliation_status) && (
                <div>
                  <dt>Reconciliation</dt>
                  <dd>
                    {selectedExpense.reconciliation_status.replaceAll("_", " ")}
                    {selectedExpense.bank_description ? (
                      <span className="filename">Bank: {selectedExpense.bank_description}</span>
                    ) : null}
                    {selectedExpense.reconciliation_candidate_notes ? (
                      <span className="filename">{selectedExpense.reconciliation_candidate_notes}</span>
                    ) : null}
                  </dd>
                </div>
              )}
              {(selectedExpense.description || selectedExpense.payment_reference) && (
                <div>
                  <dt>Notes</dt>
                  <dd>
                    {selectedExpense.description || "—"}
                    {selectedExpense.payment_reference ? (
                      <span className="filename">Ref: {selectedExpense.payment_reference}</span>
                    ) : null}
                  </dd>
                </div>
              )}
              <div>
                <dt>Logged by</dt>
                <dd>{formatExpenseLoggedBy(selectedExpense)}</dd>
              </div>
              {isTwoPercentFund(selectedExpense) && (
                <div>
                  <dt>2% Fund</dt>
                  <dd>
                    <TwoPercentTransactionBadges expense={selectedExpense} />
                    {selectedExpense.two_percent_warning_reason && (
                      <span className="filename">{selectedExpense.two_percent_warning_reason}</span>
                    )}
                    {selectedExpense.member_vote_recorded && (
                      <span className="filename">Member vote recorded</span>
                    )}
                    {selectedExpense.meeting_date && (
                      <span className="filename">Meeting: {selectedExpense.meeting_date}</span>
                    )}
                    {selectedExpense.support_note && (
                      <span className="filename">Support: {selectedExpense.support_note}</span>
                    )}
                  </dd>
                </div>
              )}
            </dl>

            {editing ? renderEditForm(selectedExpense.id, true) : null}

            <div className="transactions-drawer-actions">
              {!editing ? (
                <button type="button" onClick={() => beginEdit(selectedExpense)}>
                  Edit transaction
                </button>
              ) : null}
              {receiptUrl ? (
                <a
                  className="secondary-action transactions-drawer-link"
                  href={receiptUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View full receipt / source
                </a>
              ) : null}
            </div>

            <div className="transactions-similar-card">
              <h4>Vendor history</h4>
              {similarTransactions.length ? (
                <ul>
                  {similarTransactions.map((item) => {
                    const itemAmount = formatTransactionAmount(item);
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          className="transactions-similar-item"
                          onClick={() => setSelectedId(item.id)}
                        >
                          <span>{formatHumanDate(parseExpenseSortDate(item))}</span>
                          <span className={itemAmount.className}>{itemAmount.text}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="muted">No other transactions for this vendor in the loaded list.</p>
              )}
            </div>
          </div>
        </aside>
      </>
    );
  }

  return (
    <section className="card transactions-page">
      <header className="transactions-page-header">
        <h2>Transactions</h2>
        <p className="muted">Search, filter, and review all department transactions.</p>
        {bankAccountFilter.trim() ? (
          <div className="transactions-account-banner">
            <span>
              Showing account: <strong>{bankAccountFilter}</strong>
            </span>
            {onClearBankAccountFilter ? (
              <button type="button" className="secondary-action" onClick={onClearBankAccountFilter}>
                Clear account filter
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      <div className="transactions-metrics">
        <article className="transactions-metric-card">
          <strong>{metrics.total.toLocaleString()}</strong>
          <span>Total Transactions</span>
        </article>
        <article className="transactions-metric-card transactions-metric-warn">
          <strong>{metrics.needsReview.toLocaleString()}</strong>
          <span>Needs Review</span>
        </article>
        <article className="transactions-metric-card transactions-metric-expense">
          <strong>{formatCurrency(metrics.monthSpent)}</strong>
          <span>This Month Spent</span>
        </article>
        <article className="transactions-metric-card transactions-metric-income">
          <strong>{formatCurrency(metrics.monthIncome)}</strong>
          <span>Income This Month</span>
        </article>
      </div>

      <div className="transactions-toolbar">
        <label className="transactions-search">
          <span className="sr-only">Search vendor or memo</span>
          <input
            type="search"
            placeholder="Search vendor or memo…"
            value={vendorQuery}
            onChange={(event) => onVendorQueryChange(event.target.value)}
            autoComplete="off"
          />
        </label>

      </div>

      <div className="transactions-quick-filters" role="tablist" aria-label="Quick filters">
        {QUICK_FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            role="tab"
            aria-selected={quickFilter === filter.id}
            className={`transactions-quick-pill${quickFilter === filter.id ? " is-active" : ""}`}
            onClick={() => setQuickFilter(filter.id)}
          >
            {filter.label}
          </button>
        ))}
      </div>


      {ledgerMayTruncate ? (
        <p className="notice">
          Showing up to {LEDGER_ALL_LIMIT.toLocaleString()} expenses. Contact support if you need a larger export.
        </p>
      ) : null}

      <div className="transactions-meta-row">
        <div className="transactions-meta">
          <span>
            Showing {filteredExpenses.length} of {expenses.length} transaction
            {expenses.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="transactions-toolbar-actions" ref={filtersRef}>
          <button
            type="button"
            className={`secondary-action transactions-filters-btn${filtersOpen ? " is-active" : ""}${hasAdvancedFilters ? " has-filters" : ""}`}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            Filters
            {hasAdvancedFilters ? <span className="transactions-filter-dot" /> : null}
          </button>
          {filtersOpen ? (
            <div className="transactions-filters-panel">
              <div className="transactions-filters-grid">
                <label>
                  Vendor / memo
                  <input
                    type="search"
                    placeholder="e.g. Shell, Amazon"
                    value={vendorQuery}
                    onChange={(event) => onVendorQueryChange(event.target.value)}
                  />
                </label>
                <label>
                  Category
                  <input
                    type="search"
                    placeholder="Fuel, supplies…"
                    value={categoryFilter}
                    onChange={(event) => setCategoryFilter(event.target.value)}
                  />
                </label>
                <label>
                  From date
                  <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
                </label>
                <label>
                  To date
                  <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
                </label>
                <label>
                  Min $
                  <input
                    inputMode="decimal"
                    placeholder="0"
                    value={amountMin}
                    onChange={(event) => setAmountMin(event.target.value)}
                  />
                </label>
                <label>
                  Max $
                  <input
                    inputMode="decimal"
                    placeholder="Any"
                    value={amountMax}
                    onChange={(event) => setAmountMax(event.target.value)}
                  />
                </label>
              </div>
              <div className="transactions-presets">
                <span className="muted">Quick dates:</span>
                <button type="button" className="secondary-action" onClick={() => applyDatePreset("ytd")}>
                  Year to date
                </button>
                <button type="button" className="secondary-action" onClick={() => applyDatePreset("last_year")}>
                  Last calendar year
                </button>
                <button type="button" className="secondary-action" onClick={() => applyDatePreset("last12")}>
                  Last 12 months
                </button>
                <button type="button" className="secondary-action" onClick={() => applyDatePreset("clear")}>
                  Clear dates
                </button>
                <button type="button" className="secondary-action" onClick={clearFilters}>
                  Reset all filters
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {!expenses.length ? (
        <p className="empty-state">No expenses logged yet. Upload a receipt from the Dashboard to start.</p>
      ) : !filteredExpenses.length ? (
        <p className="empty-state">No transactions match these filters. Try clearing filters or broadening the date range.</p>
      ) : (
        <>
          <div className="transactions-table-wrap transactions-desktop-only">
            <table className="transactions-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Vendor / Description</th>
                  <th>Category</th>
                  <th>Account</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {displayExpenses.map((expense) => {
                  const amount = formatTransactionAmount(expense);
                  const status = transactionStatus(expense, receiptUrls);
                  const isSelected = selectedId === expense.id;
                  return (
                    <tr
                      key={expense.id}
                      className={`transactions-row${isSelected ? " is-selected" : ""}`}
                      onClick={() => setSelectedId(expense.id)}
                    >
                      <td className="transactions-col-date">{formatHumanDate(parseExpenseSortDate(expense))}</td>
                      <td className="transactions-col-vendor">
                        <strong>{vendorName(expense)}</strong>
                        {(expense.description || expense.payment_reference) && (
                          <span className="transactions-vendor-sub">
                            {expense.description || expense.payment_reference}
                          </span>
                        )}
                        <TwoPercentTransactionBadges expense={expense} />
                      </td>
                      <td>
                        <span className={`transactions-cat-pill ${categoryPillClass(expense.category)}`}>
                          {categoryLabel(expense)}
                        </span>
                      </td>
                      <td>{expense.bank_account_name || "—"}</td>
                      <td className={amount.className}>{amount.text}</td>
                      <td>
                        <span className={`transactions-status-pill transactions-status-${status.key}`}>
                          {status.label}
                        </span>
                      </td>
                      <td className="transactions-col-actions" onClick={(event) => event.stopPropagation()}>
                        {editingId === expense.id ? null : renderRowActions(expense)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="transactions-mobile-list transactions-mobile-only">
            {displayExpenses.map((expense) => {
              const amount = formatTransactionAmount(expense);
              const status = transactionStatus(expense, receiptUrls);
              return (
                <article
                  key={expense.id}
                  className="transactions-mobile-card"
                  onClick={() => setSelectedId(expense.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedId(expense.id);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="transactions-mobile-card-top">
                    <span className="transactions-mobile-date">
                      {formatHumanDate(parseExpenseSortDate(expense))}
                    </span>
                    <span className={amount.className}>{amount.text}</span>
                  </div>
                  <strong>{vendorName(expense)}</strong>
                  <div className="transactions-mobile-card-meta">
                    <span className={`transactions-status-pill transactions-status-${status.key}`}>
                      {status.label}
                    </span>
                    <span className={`transactions-cat-pill ${categoryPillClass(expense.category)}`}>
                      {categoryLabel(expense)}
                    </span>
                    <TwoPercentTransactionBadges expense={expense} />
                  </div>
                  <div
                    className="transactions-mobile-card-actions"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    {renderRowActions(expense)}
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}

      {selectedExpense ? renderDetailPanel() : null}
    </section>
  );
}
