"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";

import { supabase } from "../lib/supabase";
import type { BankAccount, DepartmentMembership, ExpenseRecord } from "../lib/types";

function expenseNumericAmount(total: ExpenseRecord["total_amount"]): number | null {
  if (total == null) return null;
  if (typeof total === "number") return Number.isNaN(total) ? null : total;
  const trimmed = String(total).replace(/[$,]/g, "").trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isNaN(n) ? null : n;
}

function formatUsd(amount: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(
    amount,
  );
}

function parseExpenseSortDate(expense: ExpenseRecord): string {
  const td = expense.transaction_date?.trim();
  if (td && /^\d{4}-\d{2}-\d{2}/.test(td)) return td.slice(0, 10);
  const c = expense.created_at?.slice(0, 10);
  if (c && /^\d{4}-\d{2}-\d{2}/.test(c)) return c;
  return "";
}

function formatMDYShort(y: number, month: number, day: number) {
  const yy = String(y).slice(-2);
  return `${month}/${day}/${yy}`;
}

function quarterKeyAndLabelFromISO(iso: string): { key: string; label: string } | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  const [yStr, mStr] = iso.split("-");
  const y = Number(yStr);
  const month = Number(mStr);
  if (!y || month < 1 || month > 12) return null;
  const q = month <= 3 ? 1 : month <= 6 ? 2 : month <= 9 ? 3 : 4;
  const startMonth = (q - 1) * 3 + 1;
  const endMonth = q * 3;
  const lastDay = new Date(y, endMonth, 0).getDate();
  const label = `${formatMDYShort(y, startMonth, 1)}–${formatMDYShort(y, endMonth, lastDay)}`;
  const key = `${y}-Q${q}`;
  return { key, label };
}

export function expenseNeedsReconciliationAttention(expense: ExpenseRecord) {
  if (expense.reconciliation_status !== "matched") return true;
  if (expense.extraction_status === "needs_review" || expense.extraction_status === "failed") return true;
  if (expense.reconciliation_candidate) return true;
  return false;
}

function expenseMissingReceipt(expense: ExpenseRecord, receiptUrls: Record<string, string>) {
  if (receiptUrls[expense.id]) return false;
  const path = (expense.receipt_path || "").toLowerCase();
  return path.includes("no-receipt") || path.includes("/manual/");
}

function formatDisplayDate(iso: string | null | undefined) {
  if (!iso?.trim()) return "—";
  const d = iso.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}/.test(d)) return iso;
  const [yStr, mStr, dayStr] = d.split("-");
  const date = new Date(Number(yStr), Number(mStr) - 1, Number(dayStr));
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

type ReconciliationIssueKey =
  | "needs_review"
  | "pending_bank_match"
  | "missing_receipt"
  | "duplicate"
  | "extraction_issue"
  | "extracted";

function getReconciliationIssues(
  expense: ExpenseRecord,
  receiptUrls: Record<string, string>,
): ReconciliationIssueKey[] {
  const issues: ReconciliationIssueKey[] = [];
  if (expense.extraction_status === "failed") issues.push("extraction_issue");
  if (expense.extraction_status === "needs_review") issues.push("needs_review");
  if (expense.extraction_status === "extracted") issues.push("extracted");
  if (expense.reconciliation_candidate) issues.push("duplicate");
  if (
    expense.reconciliation_status === "pending_bank_match" ||
    expense.reconciliation_status === "unreconciled" ||
    expense.reconciliation_status === "needs_attention"
  ) {
    issues.push("pending_bank_match");
  }
  if (expenseMissingReceipt(expense, receiptUrls)) issues.push("missing_receipt");
  return [...new Set(issues)];
}

const RECON_ISSUE_LABELS: Record<ReconciliationIssueKey, string> = {
  needs_review: "Needs Review",
  pending_bank_match: "Pending Bank Match",
  missing_receipt: "Missing Receipt",
  duplicate: "Duplicate",
  extraction_issue: "Extraction Issue",
  extracted: "Extracted",
};

function ReconciliationIssueCell({ issues }: { issues: ReconciliationIssueKey[] }) {
  if (!issues.length) return <span className="muted">—</span>;
  return (
    <div className="fb-recon-issue-stack">
      {issues.map((issue) => (
        <span key={issue} className={`status fb-recon-issue fb-recon-issue--${issue}`}>
          {RECON_ISSUE_LABELS[issue]}
        </span>
      ))}
    </div>
  );
}

function ReconciliationRowMenu({
  expense,
  receiptUrls,
  onReview,
  onMatch,
  onAddReceipt,
}: {
  expense: ExpenseRecord;
  receiptUrls: Record<string, string>;
  onReview: () => void;
  onMatch: () => void;
  onAddReceipt: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hasReceipt = Boolean(receiptUrls[expense.id]);
  const showMatch =
    expense.reconciliation_status === "pending_bank_match" ||
    expense.reconciliation_status === "unreconciled" ||
    expense.reconciliation_status === "needs_attention" ||
    expense.reconciliation_candidate;

  useEffect(() => {
    if (!open) return;
    function closeOnOutside(event: MouseEvent) {
      if (wrapRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="fb-row-menu" ref={wrapRef} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="fb-row-menu-trigger"
        aria-label="Row actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="12" cy="5" r="1.75" />
          <circle cx="12" cy="12" r="1.75" />
          <circle cx="12" cy="19" r="1.75" />
        </svg>
      </button>
      {open ? (
        <div className="fb-row-menu-popover" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onReview();
            }}
          >
            Review
          </button>
          {showMatch ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onMatch();
              }}
            >
              Match
            </button>
          ) : null}
          {!hasReceipt ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onAddReceipt();
              }}
            >
              Add receipt
            </button>
          ) : (
            <a
              role="menuitem"
              href={receiptUrls[expense.id]}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
            >
              View receipt
            </a>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onReview();
            }}
          >
            Edit transaction
          </button>
        </div>
      ) : null}
    </div>
  );
}

type ReconciliationQueueFilter =
  | "all"
  | "missing_receipt"
  | "pending_bank_match"
  | "needs_review"
  | "duplicate";

function buildReconciliationSummary(expenses: ExpenseRecord[], receiptUrls: Record<string, string>) {
  let unreconciled = 0;
  let missingReceipts = 0;
  let pendingBankMatch = 0;
  for (const expense of expenses) {
    if (!expenseNeedsReconciliationAttention(expense)) continue;
    unreconciled += 1;
    if (expenseMissingReceipt(expense, receiptUrls)) missingReceipts += 1;
    if (
      expense.reconciliation_status === "pending_bank_match" ||
      expense.reconciliation_status === "unreconciled" ||
      expense.reconciliation_status === "needs_attention"
    ) {
      pendingBankMatch += 1;
    }
  }
  const total = expenses.length;
  const reconciled = expenses.filter((e) => e.reconciliation_status === "matched").length;
  const percent = total ? Math.round((reconciled / total) * 100) : 0;
  return { unreconciled, missingReceipts, pendingBankMatch, reconciled, total, percent };
}

function optionalValue(value: string) {
  const trimmed = value.trim();
  return trimmed || null;
}

function optionalNumber(value: string | number | null | undefined) {
  if (value == null) return null;
  const normalized = String(value).replace(/[$,]/g, "").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function ReconciliationProgress({ expenses }: { expenses: ExpenseRecord[] }) {
  const total = expenses.length;
  const reconciled = expenses.filter((expense) => expense.reconciliation_status === "matched").length;
  const percent = total ? Math.round((reconciled / total) * 100) : 0;
  return (
    <div className="reconciliation-progress">
      <span className="reconciliation-progress__label">
        Reconciled progress: {reconciled}/{total} ({percent}%)
      </span>
      <div
        className="reconciliation-progress__track"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="reconciliation-progress__fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export function ReconciliationInboxSection({
  expenses,
  receiptUrls,
  bankAccounts,
  membership,
  user,
  onExpensesChanged,
  showErrorMessage,
  showSuccessMessage,
  onOpenFullReport,
  onOpenUploadStatement,
  onOpenTransactions,
  onOpenNewExpense,
}: {
  expenses: ExpenseRecord[];
  receiptUrls: Record<string, string>;
  bankAccounts: BankAccount[];
  membership: DepartmentMembership;
  user: User;
  onExpensesChanged: () => Promise<void>;
  showErrorMessage: (message: string) => void;
  showSuccessMessage: (message: string | null) => void;
  onOpenFullReport: () => void;
  onOpenUploadStatement: () => void;
  onOpenTransactions: () => void;
  onOpenNewExpense: () => void;
}) {
  const [accountFilter, setAccountFilter] = useState("");
  const [periodFilter, setPeriodFilter] = useState("");
  const [queueFilter, setQueueFilter] = useState<ReconciliationQueueFilter>("all");
  const [moreOpen, setMoreOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lastBankSync, setLastBankSync] = useState<string | null>(null);
  const [statementPeriods, setStatementPeriods] = useState<Array<{ key: string; label: string }>>([]);

  const actionItems = useMemo(() => expenses.filter((e) => expenseNeedsReconciliationAttention(e)), [expenses]);
  const summary = useMemo(() => buildReconciliationSummary(expenses, receiptUrls), [expenses, receiptUrls]);

  const periodOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const upload of statementPeriods) map.set(upload.key, upload.label);
    for (const expense of actionItems) {
      const iso = parseExpenseSortDate(expense);
      const q = quarterKeyAndLabelFromISO(iso);
      if (q) map.set(q.key, q.label);
    }
    return [...map.entries()]
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => b.key.localeCompare(a.key));
  }, [actionItems, statementPeriods]);

  useEffect(() => {
    let cancelled = false;
    async function loadMeta() {
      const [{ data: txRows }, { data: uploadRows }] = await Promise.all([
        supabase
          .from("external_transactions")
          .select("created_at")
          .eq("department_id", membership.department_id)
          .order("created_at", { ascending: false })
          .limit(1),
        supabase
          .from("bank_statement_uploads")
          .select("statement_start_date,statement_end_date,created_at")
          .eq("department_id", membership.department_id)
          .order("created_at", { ascending: false })
          .limit(12),
      ]);
      if (cancelled) return;
      setLastBankSync(txRows?.[0]?.created_at ? String(txRows[0].created_at) : null);
      const periods: Array<{ key: string; label: string }> = [];
      for (const row of uploadRows || []) {
        const start = row.statement_start_date;
        const end = row.statement_end_date;
        if (start && end) {
          periods.push({
            key: `${start}_${end}`,
            label: `${formatDisplayDate(start)} – ${formatDisplayDate(end)}`,
          });
        }
      }
      setStatementPeriods(periods);
    }
    void loadMeta();
    return () => {
      cancelled = true;
    };
  }, [membership.department_id]);

  const filteredItems = useMemo(() => {
    let list = actionItems;
    if (accountFilter) {
      const b = accountFilter.toLowerCase();
      list = list.filter((e) => (e.bank_account_name || "").trim().toLowerCase() === b);
    }
    if (periodFilter) {
      if (periodFilter.includes("_")) {
        const [start, end] = periodFilter.split("_");
        list = list.filter((e) => {
          const d = parseExpenseSortDate(e);
          return d && d >= start && d <= end;
        });
      } else {
        list = list.filter((e) => quarterKeyAndLabelFromISO(parseExpenseSortDate(e))?.key === periodFilter);
      }
    }
    if (queueFilter === "missing_receipt") list = list.filter((e) => expenseMissingReceipt(e, receiptUrls));
    else if (queueFilter === "pending_bank_match") {
      list = list.filter(
        (e) =>
          e.reconciliation_status === "pending_bank_match" ||
          e.reconciliation_status === "unreconciled" ||
          e.reconciliation_status === "needs_attention",
      );
    } else if (queueFilter === "needs_review") {
      list = list.filter((e) => e.extraction_status === "needs_review" || e.extraction_status === "failed");
    } else if (queueFilter === "duplicate") {
      list = list.filter((e) => Boolean(e.reconciliation_candidate));
    }
    return list.sort((a, b) => parseExpenseSortDate(b).localeCompare(parseExpenseSortDate(a)));
  }, [actionItems, accountFilter, periodFilter, queueFilter, receiptUrls]);

  const selectedExpense = useMemo(
    () => (selectedId ? expenses.find((e) => e.id === selectedId) ?? null : null),
    [expenses, selectedId],
  );

  const lastSyncLabel = lastBankSync
    ? formatDisplayDate(lastBankSync.slice(0, 10))
    : bankAccounts.length
      ? "Not synced yet"
      : "—";

  return (
    <div className="fb-recon-page">
      <header className="fb-recon-header">
        <h1 className="fb-dash-title">Reconciliation</h1>
        <p className="fb-dash-subtitle">
          Review unreconciled transactions, missing receipts, and items that still need a bank match.
        </p>
      </header>

      <div className="fb-recon-summary">
        <div className="fb-recon-stat-card">
          <span className="fb-recon-stat-icon fb-recon-stat-icon--alert" aria-hidden>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            </svg>
          </span>
          <div>
            <p className="fb-recon-stat-label">Unreconciled Transactions</p>
            <p className="fb-recon-stat-value">{summary.unreconciled}</p>
            <p className="fb-recon-stat-hint">{summary.percent}% cleared overall</p>
          </div>
        </div>
        <div className="fb-recon-stat-card">
          <span className="fb-recon-stat-icon fb-recon-stat-icon--amber" aria-hidden>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
              <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
            </svg>
          </span>
          <div>
            <p className="fb-recon-stat-label">Missing Receipts</p>
            <p className="fb-recon-stat-value">{summary.missingReceipts}</p>
          </div>
        </div>
        <div className="fb-recon-stat-card">
          <span className="fb-recon-stat-icon fb-recon-stat-icon--blue" aria-hidden>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 10h18M7 15h1m4 0h1m-7 4h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2Z" />
            </svg>
          </span>
          <div>
            <p className="fb-recon-stat-label">Pending Bank Match</p>
            <p className="fb-recon-stat-value">{summary.pendingBankMatch}</p>
          </div>
        </div>
        <div className="fb-recon-stat-card">
          <span className="fb-recon-stat-icon fb-recon-stat-icon--muted" aria-hidden>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-6.22-8.56M21 3v6h-6" />
            </svg>
          </span>
          <div>
            <p className="fb-recon-stat-label">Last Bank Sync</p>
            <p className="fb-recon-stat-value fb-recon-stat-value--sm">{lastSyncLabel}</p>
          </div>
        </div>
      </div>

      <div className="fb-recon-controls">
        <label className="fb-recon-control">
          <span className="fb-recon-control-label">Account</span>
          <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
            <option value="">All accounts</option>
            {bankAccounts.map((account) => (
              <option key={account.id} value={account.name}>
                {account.name}
              </option>
            ))}
          </select>
        </label>
        <label className="fb-recon-control">
          <span className="fb-recon-control-label">Statement period</span>
          <select value={periodFilter} onChange={(e) => setPeriodFilter(e.target.value)}>
            <option value="">All periods</option>
            {periodOptions.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="fb-recon-control">
          <span className="fb-recon-control-label">Filter</span>
          <select value={queueFilter} onChange={(e) => setQueueFilter(e.target.value as ReconciliationQueueFilter)}>
            <option value="all">All unreconciled</option>
            <option value="missing_receipt">Missing receipt</option>
            <option value="pending_bank_match">Pending bank match</option>
            <option value="needs_review">Needs review</option>
            <option value="duplicate">Possible duplicate</option>
          </select>
        </label>
        <div className="fb-recon-controls-actions">
          <button type="button" className="fb-primary-btn" onClick={onOpenUploadStatement}>
            Upload statement
          </button>
          <div className="fb-recon-more-wrap">
            <button
              type="button"
              className="fb-secondary-btn"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((o) => !o)}
            >
              More actions
            </button>
            {moreOpen ? (
              <div className="fb-recon-more-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMoreOpen(false);
                    onOpenFullReport();
                  }}
                >
                  Open full reconciliation report
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMoreOpen(false);
                    onOpenTransactions();
                  }}
                >
                  View all transactions
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="fb-recon-layout">
        <section className="card fb-ledger-card fb-recon-main">
          <div className="section-heading">
            <h2>Unreconciled Transactions</h2>
            <p className="muted">These items still need a receipt, match, or review.</p>
          </div>

          {filteredItems.length ? (
            <>
              <p className="fb-recon-queue-meta">
                Showing {filteredItems.length} item{filteredItems.length === 1 ? "" : "s"}
              </p>
              <div className="table-wrap fb-recon-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Vendor / Description</th>
                      <th>Account</th>
                      <th>Amount</th>
                      <th>Issue</th>
                      <th className="fb-col-actions">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredItems.slice(0, 200).map((expense) => (
                      <ReconciliationTableRow
                        key={expense.id}
                        expense={expense}
                        receiptUrls={receiptUrls}
                        isSelected={selectedId === expense.id}
                        onSelect={() => setSelectedId(expense.id)}
                        onReview={() => setSelectedId(expense.id)}
                        onMatch={onOpenFullReport}
                        onAddReceipt={onOpenNewExpense}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="empty-state">
              {actionItems.length
                ? "No items match these filters. Try broadening account or period filters."
                : "Nothing needs attention right now. Matched transactions remain in the Transactions tab."}
            </p>
          )}
        </section>

        <aside className="fb-recon-aside">
          <section className="card fb-recon-help-card">
            <h2 className="fb-recon-aside-title">How reconciliation works</h2>
            <ol className="fb-recon-steps">
              <li>Review unreconciled items</li>
              <li>Match to a bank transaction or add a receipt</li>
              <li>Mark complete when records are ready</li>
            </ol>
            <div className="fb-recon-progress-compact">
              <ReconciliationProgress expenses={expenses} />
            </div>
          </section>
          <section className="card fb-recon-help-card fb-recon-help-card--secondary">
            <h3 className="fb-recon-aside-subtitle">Need help?</h3>
            <button type="button" className="link-button" onClick={onOpenFullReport}>
              View reconciliation guide
            </button>
            <a className="link-button" href="mailto:support@firebook.app">
              Contact support
            </a>
          </section>
        </aside>
      </div>

      {selectedExpense ? (
        <ReconciliationDetailDrawer
          expense={selectedExpense}
          receiptUrls={receiptUrls}
          user={user}
          onClose={() => setSelectedId(null)}
          onExpensesChanged={onExpensesChanged}
          showErrorMessage={showErrorMessage}
          showSuccessMessage={showSuccessMessage}
          onOpenFullReport={onOpenFullReport}
          onOpenNewExpense={onOpenNewExpense}
        />
      ) : null}
    </div>
  );
}

function ReconciliationTableRow({
  expense,
  receiptUrls,
  isSelected,
  onSelect,
  onReview,
  onMatch,
  onAddReceipt,
}: {
  expense: ExpenseRecord;
  receiptUrls: Record<string, string>;
  isSelected: boolean;
  onSelect: () => void;
  onReview: () => void;
  onMatch: () => void;
  onAddReceipt: () => void;
}) {
  const issues = getReconciliationIssues(expense, receiptUrls);
  const vendor = expense.payee || expense.merchant_name || "Needs review";
  const memo = expense.description || expense.payment_reference || null;
  const source = memo ? null : expense.original_filename;
  const subline = memo || source;
  const amount = expenseNumericAmount(expense.total_amount);

  return (
    <tr
      className={`fb-recon-ledger-row ${isSelected ? "fb-recon-ledger-row--selected" : ""}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      tabIndex={0}
      role="button"
    >
      <td className="fb-col-date">{formatDisplayDate(expense.transaction_date)}</td>
      <td className="fb-col-vendor">
        <strong className="fb-recon-vendor">{vendor}</strong>
        {subline ? <span className="filename">{subline}</span> : null}
      </td>
      <td className="fb-col-account">{expense.bank_account_name?.trim() || "—"}</td>
      <td className="fb-col-amount">
        {amount != null ? (
          <span className={amount < 0 ? "fb-amount-income" : "fb-amount-expense"}>{formatUsd(Math.abs(amount))}</span>
        ) : (
          "—"
        )}
      </td>
      <td className="fb-col-issue">
        <ReconciliationIssueCell issues={issues} />
      </td>
      <td className="fb-col-actions">
        <ReconciliationRowMenu
          expense={expense}
          receiptUrls={receiptUrls}
          onReview={onReview}
          onMatch={onMatch}
          onAddReceipt={onAddReceipt}
        />
      </td>
    </tr>
  );
}

function ReconciliationDetailDrawer({
  expense,
  receiptUrls,
  user,
  onClose,
  onExpensesChanged,
  showErrorMessage,
  showSuccessMessage,
  onOpenFullReport,
  onOpenNewExpense,
}: {
  expense: ExpenseRecord;
  receiptUrls: Record<string, string>;
  user: User;
  onClose: () => void;
  onExpensesChanged: () => Promise<void>;
  showErrorMessage: (message: string) => void;
  showSuccessMessage: (message: string | null) => void;
  onOpenFullReport: () => void;
  onOpenNewExpense: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editReason, setEditReason] = useState("");
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const issues = getReconciliationIssues(expense, receiptUrls);
  const amount = expenseNumericAmount(expense.total_amount);
  const receiptUrl = receiptUrls[expense.id];
  const hasReceipt = Boolean(receiptUrl);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function startEdit() {
    setEditing(true);
    setEditReason("");
    setEditValues({
      payee: expense.payee || expense.merchant_name || "",
      total_amount: expense.total_amount == null ? "" : String(expense.total_amount),
      transaction_date: expense.transaction_date || "",
      category: expense.category || "",
      bank_account_name: expense.bank_account_name || "",
      description: expense.description || "",
    });
  }

  async function saveEdit() {
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
      .eq("id", expense.id);
    if (error) {
      showErrorMessage(error.message);
      return;
    }
    setEditing(false);
    showSuccessMessage("Expense updated.");
    await onExpensesChanged();
  }

  return (
    <div className="fb-drawer-root" role="presentation" onClick={onClose}>
      <div
        className="fb-drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fb-recon-drawer-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fb-drawer-head">
          <div>
            <p className="eyebrow">Transaction detail</p>
            <h2 id="fb-recon-drawer-title">{expense.payee || expense.merchant_name || "Needs review"}</h2>
          </div>
          <button type="button" className="fb-drawer-close secondary-action" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <div className="fb-drawer-body">
          <dl className="fb-drawer-facts">
            <div>
              <dt>Date</dt>
              <dd>{formatDisplayDate(expense.transaction_date)}</dd>
            </div>
            <div>
              <dt>Amount</dt>
              <dd>
                {amount != null ? (
                  <span className={amount < 0 ? "fb-amount-income" : "fb-amount-expense"}>
                    {formatUsd(Math.abs(amount))}
                  </span>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt>Account</dt>
              <dd>{expense.bank_account_name || "—"}</dd>
            </div>
            <div>
              <dt>Extraction</dt>
              <dd>
                <span className={`status status-${expense.extraction_status}`}>
                  {expense.extraction_status.replaceAll("_", " ")}
                </span>
              </dd>
            </div>
            <div>
              <dt>Bank match</dt>
              <dd>
                <span className={`status status-${expense.reconciliation_status}`}>
                  {expense.reconciliation_status.replaceAll("_", " ")}
                </span>
                {expense.reconciliation_candidate ? (
                  <span className="filename">
                    {expense.reconciliation_candidate_notes || "Possible match — review in full report"}
                  </span>
                ) : null}
                {expense.bank_description ? (
                  <span className="filename">
                    Bank: {expense.bank_description}
                    {expense.bank_amount != null ? ` (${expense.bank_amount})` : ""}
                  </span>
                ) : null}
              </dd>
            </div>
          </dl>

          <ReconciliationIssueCell issues={issues} />

          {receiptUrl ? (
            <div className="fb-drawer-receipt">
              <p className="summary-label">Receipt / source</p>
              {expense.content_type?.startsWith("image/") ? (
                <img src={receiptUrl} alt="Receipt preview" className="fb-drawer-receipt-img" />
              ) : null}
              <a href={receiptUrl} target="_blank" rel="noopener noreferrer">
                View source ({expense.original_filename})
              </a>
            </div>
          ) : (
            <p className="note">No receipt on file for this transaction.</p>
          )}

          {editing ? (
            <div className="form-stack">
              <input
                placeholder="Vendor"
                value={editValues.payee || ""}
                onChange={(e) => setEditValues((p) => ({ ...p, payee: e.target.value }))}
              />
              <input
                placeholder="Amount"
                value={editValues.total_amount || ""}
                onChange={(e) => setEditValues((p) => ({ ...p, total_amount: e.target.value }))}
              />
              <input
                type="date"
                value={editValues.transaction_date || ""}
                onChange={(e) => setEditValues((p) => ({ ...p, transaction_date: e.target.value }))}
              />
              <input
                placeholder="Category"
                value={editValues.category || ""}
                onChange={(e) => setEditValues((p) => ({ ...p, category: e.target.value }))}
              />
              <input
                placeholder="Bank account"
                value={editValues.bank_account_name || ""}
                onChange={(e) => setEditValues((p) => ({ ...p, bank_account_name: e.target.value }))}
              />
              <textarea
                rows={2}
                placeholder="Reason for edit (required)"
                value={editReason}
                onChange={(e) => setEditReason(e.target.value)}
              />
              <div className="button-row">
                <button type="button" onClick={() => void saveEdit()}>
                  Save edit
                </button>
                <button type="button" className="secondary-action" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="fb-drawer-foot">
          {!editing ? (
            <button type="button" className="secondary-action" onClick={startEdit}>
              Edit
            </button>
          ) : null}
          <button type="button" className="secondary-action" onClick={onOpenFullReport}>
            Match
          </button>
          {!hasReceipt ? (
            <button type="button" className="secondary-action" onClick={onOpenNewExpense}>
              Add receipt
            </button>
          ) : (
            <a
              href={receiptUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="secondary-action fb-recon-link-action"
            >
              View receipt
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
