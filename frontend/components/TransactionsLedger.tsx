"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";

import { receiptsBucket, supabase } from "../lib/supabase";
import {
  buildCategoryOptions,
  isUncategorizedCategory,
  normalizeCategoryName,
  suggestCategory,
} from "../lib/categories";
import { evaluateTwoPercentStatus } from "../lib/two-percent-rules";
import type { BankAccount, DepartmentCategory, DepartmentVendor, ExpenseRecord, ReceiptRequest } from "../lib/types";

const LEDGER_ALL_LIMIT = 5000;

type TransactionEditValues = {
  payee: string;
  total_amount: string;
  transaction_date: string;
  category: string;
  bank_account_name: string;
  description: string;
  uses_two_percent_funds: boolean;
};

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
  | "extracted"
  | "receipt_requested"
  | "receipt_received";

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

function formatTableDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const raw = iso.trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return raw;
  const [, y, m, d] = match;
  const month = Number(m);
  const day = Number(d);
  if (!month || !day) return raw;
  return `${month}/${day}/${y.slice(-2)}`;
}

function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Math.abs(amount));
}

function vendorName(expense: ExpenseRecord) {
  return expense.payee || expense.merchant_name || "Needs review";
}

function TwoPercentColumnCell({ expense }: { expense: ExpenseRecord }) {
  if (!isTwoPercentFund(expense)) {
    return <span className="transactions-2pct-empty">—</span>;
  }
  return (
    <span className="fb-2pct-badge fb-2pct-badge--fund transactions-2pct-col-badge" title="NYS 2% fund transaction">
      2%
    </span>
  );
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

function transactionStatus(
  expense: ExpenseRecord,
  receiptUrls: Record<string, string>,
  receiptRequests?: ReceiptRequest[],
): StatusInfo {
  if (
    expense.extraction_status === "needs_review" ||
    expense.extraction_status === "failed" ||
    expense.reconciliation_status === "needs_attention"
  ) {
    return { label: "Needs Review", key: "needs_review" };
  }
  if (isMissingReceipt(expense, receiptUrls)) {
    // Check if there's a completed receipt request (received by text)
    const completedRequest = receiptRequests?.find(
      (r) => r.expense_id === expense.id && r.status === "completed",
    );
    if (completedRequest) {
      return { label: "Receipt received by text", key: "receipt_received" };
    }
    // Check if there's a pending receipt request (SMS sent)
    const pendingRequest = receiptRequests?.find(
      (r) => r.expense_id === expense.id && r.status === "pending",
    );
    if (pendingRequest) {
      return { label: "Receipt requested", key: "receipt_requested" };
    }
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
  bankAccounts = [],
  departmentCategories = [],
  departmentVendors = [],
  onCategoriesChanged,
  receiptRequests = [],
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
  bankAccounts?: BankAccount[];
  departmentCategories?: DepartmentCategory[];
  departmentVendors?: DepartmentVendor[];
  onCategoriesChanged?: () => Promise<void>;
  receiptRequests?: ReceiptRequest[];
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editReason, setEditReason] = useState("");
  const [editValues, setEditValues] = useState<TransactionEditValues>({
    payee: "",
    total_amount: "",
    transaction_date: "",
    category: "",
    bank_account_name: "",
    description: "",
    uses_two_percent_funds: false,
  });
  const [categoryFilter, setCategoryFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [pendingCategories, setPendingCategories] = useState<Record<string, string>>({});
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [applyingAll, setApplyingAll] = useState(false);
  const [catReviewOpen, setCatReviewOpen] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const filtersRef = useRef<HTMLDivElement>(null);

  const selectedExpense = useMemo(
    () => expenses.find((e) => e.id === selectedId) ?? null,
    [expenses, selectedId],
  );

  const panelExpense = useMemo(() => {
    if (selectedExpense) return selectedExpense;
    if (!editingId) return null;
    return expenses.find((e) => e.id === editingId) ?? null;
  }, [expenses, selectedExpense, editingId]);

  const twoPctCategoryOptions = useMemo(
    () => buildCategoryOptions(expenses, departmentCategories, { twoPctMode: true }),
    [expenses, departmentCategories],
  );

  const editCategoryOptions = useMemo(() => {
    if (!editValues.uses_two_percent_funds) return [];
    const current = editValues.category.trim();
    if (current && !twoPctCategoryOptions.includes(current)) {
      return [current, ...twoPctCategoryOptions];
    }
    return twoPctCategoryOptions;
  }, [editValues.uses_two_percent_funds, editValues.category, twoPctCategoryOptions]);

  const uncategorizedTwoPct = useMemo(
    () =>
      expenses.filter(
        (e) => isTwoPercentFund(e) && isUncategorizedCategory(e.category),
      ),
    [expenses],
  );

  useEffect(() => {
    setPendingCategories((prev) => {
      const next: Record<string, string> = {};
      for (const expense of uncategorizedTwoPct) {
        const suggested =
          prev[expense.id] ||
          suggestCategory({
            vendor: expense.payee || expense.merchant_name || "",
            description: expense.description,
            ocrText: [expense.description, expense.bank_description].filter(Boolean).join(" "),
            expenses,
            departmentCategories,
            departmentVendors,
            isTwoPctAccount: true,
          }) ||
          "Other 2% Expense";
        next[expense.id] = suggested;
      }
      return next;
    });
  }, [uncategorizedTwoPct, expenses, departmentCategories, departmentVendors]);

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
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") closeDetailPanel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    function onDocClick(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (target.closest(".transactions-drawer")) return;
      if (target.closest(".transactions-row-menu")) return;
      if (target.closest(".transactions-row, .transactions-mobile-card")) {
        setEditingId(null);
        return;
      }
      closeDetailPanel();
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
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
      const status = transactionStatus(expense, receiptUrls, receiptRequests);
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

  async function ensureCategoryEnabled(categoryName: string) {
    const norm = normalizeCategoryName(categoryName);
    const existing = departmentCategories.find((c) => c.normalized_name === norm);
    if (existing && !existing.is_active && onCategoriesChanged) {
      await supabase
        .from("department_categories")
        .update({
          is_active: true,
          created_from: "bank",
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      await onCategoriesChanged();
    }
  }

  async function applySuggestedCategory(expenseId: string) {
    const category = (pendingCategories[expenseId] || "").trim();
    if (!category) {
      showErrorMessage("Choose a category first.");
      return;
    }
    setApplyingId(expenseId);
    try {
      const { error } = await supabase
        .from("expenses")
        .update({
          category,
          last_manual_edit_reason: "Applied suggested 2% category",
          last_manual_edit_at: new Date().toISOString(),
          last_manual_edit_by: user.email || user.id,
        })
        .eq("id", expenseId);
      if (error) throw error;
      await ensureCategoryEnabled(category);
      showSuccessMessage(`Categorized as "${category}".`);
      await onExpensesChanged();
    } catch (err) {
      showErrorMessage(err instanceof Error ? err.message : "Could not apply category.");
    } finally {
      setApplyingId(null);
    }
  }

  async function applyAllSuggestedCategories() {
    if (!uncategorizedTwoPct.length) return;
    setApplyingAll(true);
    try {
      let applied = 0;
      for (const expense of uncategorizedTwoPct) {
        const category = (pendingCategories[expense.id] || "Other 2% Expense").trim();
        const { error } = await supabase
          .from("expenses")
          .update({
            category,
            last_manual_edit_reason: "Applied suggested 2% category (batch)",
            last_manual_edit_at: new Date().toISOString(),
            last_manual_edit_by: user.email || user.id,
          })
          .eq("id", expense.id);
        if (!error) {
          applied += 1;
          await ensureCategoryEnabled(category);
        }
      }
      showSuccessMessage(`Applied categories to ${applied} transaction${applied === 1 ? "" : "s"}.`);
      await onExpensesChanged();
    } catch (err) {
      showErrorMessage(err instanceof Error ? err.message : "Could not apply categories.");
    } finally {
      setApplyingAll(false);
    }
  }

  function closeDetailPanel() {
    setEditingId(null);
    setSelectedId(null);
    setEditReason("");
  }

  function openEditPanel(expense: ExpenseRecord) {
    setSelectedId(expense.id);
    beginEdit(expense);
  }

  function beginEdit(expense: ExpenseRecord) {
    const linkedAcct = bankAccounts.find(
      (a) => a.name.toLowerCase() === (expense.bank_account_name || "").trim().toLowerCase(),
    );
    setEditingId(expense.id);
    setEditReason("");
    setEditValues({
      payee: expense.payee || expense.merchant_name || "",
      total_amount: expense.total_amount == null ? "" : String(expense.total_amount),
      transaction_date: expense.transaction_date || "",
      category: expense.category || "",
      bank_account_name: expense.bank_account_name || "",
      description: expense.description || "",
      uses_two_percent_funds:
        Boolean(expense.uses_two_percent_funds) || Boolean(linkedAcct?.is_two_percent_account),
    });
    setMenuOpenId(null);
  }

  function handleEditTwoPctToggle(checked: boolean) {
    setEditValues((prev) => {
      const next: TransactionEditValues = { ...prev, uses_two_percent_funds: checked };
      if (checked) {
        const twoPctAcct = bankAccounts.find((a) => a.is_two_percent_account);
        if (twoPctAcct) {
          next.bank_account_name = twoPctAcct.name;
        }
        if (!prev.category.trim()) {
          const suggestion = suggestCategory({
            vendor: prev.payee,
            description: prev.description,
            expenses,
            departmentCategories,
            departmentVendors,
            isTwoPctAccount: true,
          });
          if (suggestion) next.category = suggestion;
        }
      }
      return next;
    });
  }

  function handleEditBankAccountChange(accountName: string) {
    const acct = bankAccounts.find(
      (a) => a.name.toLowerCase() === accountName.trim().toLowerCase(),
    );
    setEditValues((prev) => ({
      ...prev,
      bank_account_name: accountName,
      uses_two_percent_funds: acct?.is_two_percent_account ? true : prev.uses_two_percent_funds,
    }));
  }

  async function saveEdit(expenseId: string) {
    if (!editReason.trim()) {
      showErrorMessage("Enter a reason for manual edits.");
      return;
    }
    const isTwoPct = Boolean(editValues.uses_two_percent_funds);
    const twoPctEvalRaw = isTwoPct
      ? evaluateTwoPercentStatus({
          vendor: editValues.payee,
          category: editValues.category,
          description: editValues.description,
        })
      : null;
    const twoPctEval = twoPctEvalRaw?.status === "needs_review" ? null : twoPctEvalRaw;

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
        uses_two_percent_funds: isTwoPct,
        two_percent_review_status: isTwoPct ? (twoPctEval?.status ?? null) : null,
        two_percent_warning_reason: isTwoPct ? (twoPctEval?.reason ?? null) : null,
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

  async function deleteExpense(expense: ExpenseRecord) {
    const label = vendorName(expense);
    const amount = formatTransactionAmount(expense);
    if (
      !window.confirm(
        `Delete this transaction?\n\n${label} — ${amount.text}\n\nThis cannot be undone.`,
      )
    ) {
      return;
    }
    setDeletingId(expense.id);
    setMenuOpenId(null);
    try {
      const path = expense.receipt_path?.trim();
      if (
        path &&
        !path.includes("no-receipt") &&
        !path.includes("/manual/")
      ) {
        await supabase.storage.from(receiptsBucket).remove([path]);
      }
      const { error } = await supabase.from("expenses").delete().eq("id", expense.id);
      if (error) throw error;
      setEditingId(null);
      setSelectedId(null);
      showSuccessMessage("Transaction deleted.");
      await onExpensesChanged();
    } catch (err) {
      showErrorMessage(err instanceof Error ? err.message : "Could not delete transaction.");
    } finally {
      setDeletingId(null);
    }
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

  function openReceiptFullSize(receiptUrl: string) {
    window.open(receiptUrl, "_blank", "noopener,noreferrer");
  }

  function renderReceiptPreview(
    expense: ExpenseRecord,
    receiptUrl: string | undefined,
    variant: "view" | "edit" = "edit",
  ) {
    if (!receiptUrl) return null;
    const previewClass =
      variant === "edit"
        ? "transactions-receipt-preview transactions-edit-receipt"
        : "transactions-receipt-preview transactions-receipt-preview-view";

    if (canPreviewReceipt(expense, receiptUrl)) {
      if (variant === "view") {
        return (
          <div className={previewClass}>
            <button
              type="button"
              className="transactions-receipt-thumb-btn"
              onClick={() => openReceiptFullSize(receiptUrl)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={receiptUrl} alt={`Receipt for ${vendorName(expense)}`} />
              <span className="transactions-receipt-thumb-hint">Click to view full receipt</span>
            </button>
          </div>
        );
      }

      return (
        <div className={previewClass}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={receiptUrl} alt={`Receipt for ${vendorName(expense)}`} />
          <a
            className="transactions-edit-receipt-link"
            href={receiptUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open receipt full size
          </a>
        </div>
      );
    }

    return (
      <div className={previewClass}>
        <div className="transactions-receipt-fallback">
          <p className="muted">Receipt on file ({expense.original_filename})</p>
          <button
            type="button"
            className="transactions-edit-receipt-link transactions-receipt-open-btn"
            onClick={() => openReceiptFullSize(receiptUrl)}
          >
            Open receipt
          </button>
        </div>
      </div>
    );
  }

  function renderEditForm(expense: ExpenseRecord, receiptUrl?: string) {
    const expenseId = expense.id;
    const isDeleting = deletingId === expenseId;
    return (
      <form
        className="transactions-edit-sheet"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void saveEdit(expenseId);
        }}
      >
        {renderReceiptPreview(expense, receiptUrl, "edit")}

        <header className="transactions-edit-intro">
          <h4>Edit transaction</h4>
          <p>
            {receiptUrl
              ? "Check the receipt above, then update the fields below and press "
              : "Update the details below, then press "}
            <strong>Save changes</strong>.
          </p>
        </header>

        <fieldset className="transactions-edit-group">
          <legend>Basics</legend>
          <label className="transactions-edit-field">
            <span>Vendor (who you paid)</span>
            <input
              value={editValues.payee || ""}
              onChange={(event) => setEditValues((prev) => ({ ...prev, payee: event.target.value }))}
            />
          </label>
          <div className="transactions-edit-row-2">
            <label className="transactions-edit-field">
              <span>Amount</span>
              <input
                inputMode="decimal"
                value={editValues.total_amount || ""}
                onChange={(event) =>
                  setEditValues((prev) => ({ ...prev, total_amount: event.target.value }))
                }
              />
            </label>
            <label className="transactions-edit-field">
              <span>Date</span>
              <input
                type="date"
                value={editValues.transaction_date || ""}
                onChange={(event) =>
                  setEditValues((prev) => ({ ...prev, transaction_date: event.target.value }))
                }
              />
            </label>
          </div>
        </fieldset>

        <fieldset className="transactions-edit-group">
          <legend>2% fund</legend>
          <label className="transactions-edit-check">
            <input
              type="checkbox"
              checked={editValues.uses_two_percent_funds}
              onChange={(event) => handleEditTwoPctToggle(event.target.checked)}
            />
            <span>This transaction uses 2% funds</span>
          </label>
          <p className="transactions-edit-hint">
            When checked, the bank account switches to your 2% account automatically.
          </p>
        </fieldset>

        <fieldset className="transactions-edit-group">
          <legend>Account &amp; category</legend>
          {bankAccounts.length ? (
            <label className="transactions-edit-field">
              <span>Bank account</span>
              <select
                value={editValues.bank_account_name || ""}
                onChange={(event) => handleEditBankAccountChange(event.target.value)}
              >
                <option value="">Choose account…</option>
                {bankAccounts.map((account) => (
                  <option key={account.id} value={account.name}>
                    {account.name}
                    {account.is_two_percent_account ? " (2% account)" : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="transactions-edit-field">
              <span>Bank account</span>
              <input
                value={editValues.bank_account_name || ""}
                onChange={(event) =>
                  setEditValues((prev) => ({ ...prev, bank_account_name: event.target.value }))
                }
              />
            </label>
          )}
          {editValues.uses_two_percent_funds ? (
            <label className="transactions-edit-field">
              <span>2% category</span>
              <select
                value={editValues.category || ""}
                onChange={(event) =>
                  setEditValues((prev) => ({ ...prev, category: event.target.value }))
                }
              >
                <option value="">Choose category…</option>
                {editCategoryOptions.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="transactions-edit-field">
              <span>Category</span>
              <input
                value={editValues.category || ""}
                onChange={(event) =>
                  setEditValues((prev) => ({ ...prev, category: event.target.value }))
                }
              />
            </label>
          )}
        </fieldset>

        <details className="transactions-edit-more">
          <summary>Notes (optional)</summary>
          <label className="transactions-edit-field">
            <span>Description or memo</span>
            <textarea
              rows={2}
              value={editValues.description || ""}
              onChange={(event) =>
                setEditValues((prev) => ({ ...prev, description: event.target.value }))
              }
            />
          </label>
        </details>

        <fieldset className="transactions-edit-group">
          <legend>Reason for change</legend>
          <label className="transactions-edit-field">
            <span>Why are you editing this? (required)</span>
            <textarea
              rows={2}
              value={editReason}
              onChange={(event) => setEditReason(event.target.value)}
              placeholder="Example: Corrected vendor name from receipt"
            />
          </label>
        </fieldset>

        <div className="transactions-edit-actions">
          <button type="submit" className="fb-primary-btn" disabled={isDeleting}>
            Save changes
          </button>
          <button
            type="button"
            className="fb-secondary-btn"
            disabled={isDeleting}
            onClick={() => setEditingId(null)}
          >
            Back to details
          </button>
        </div>

        <div className="transactions-edit-danger">
          <button
            type="button"
            className="transactions-delete-btn"
            disabled={isDeleting}
            onClick={() => void deleteExpense(expense)}
          >
            {isDeleting ? "Deleting…" : "Delete this transaction"}
          </button>
        </div>
      </form>
    );
  }

  function renderRowActions(expense: ExpenseRecord) {
    const receiptUrl = receiptUrls[expense.id];
    const stopMenuEvent = (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
    };
    return (
      <div
        className="transactions-row-menu"
        onMouseDown={stopMenuEvent}
        onClick={stopMenuEvent}
      >
        <button
          type="button"
          className="transactions-menu-trigger"
          aria-label="Transaction actions"
          aria-expanded={menuOpenId === expense.id}
          onClick={() => {
            setMenuOpenId((current) => (current === expense.id ? null : expense.id));
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
                openEditPanel(expense);
              }}
            >
              Edit transaction
            </button>
            {receiptUrl ? (
              <button
                type="button"
                role="menuitem"
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuOpenId(null);
                  openReceiptFullSize(receiptUrl);
                }}
              >
                View full receipt
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              className="transactions-menu-delete"
              disabled={deletingId === expense.id}
              onClick={(event) => {
                event.stopPropagation();
                void deleteExpense(expense);
              }}
            >
              {deletingId === expense.id ? "Deleting…" : "Delete transaction"}
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  function renderDetailPanel() {
    if (!panelExpense) return null;
    const receiptUrl = receiptUrls[panelExpense.id];
    const amount = formatTransactionAmount(panelExpense);
    const status = transactionStatus(panelExpense, receiptUrls, receiptRequests);
    const editing = editingId === panelExpense.id;

    return (
        <aside className={`transactions-drawer${editing ? " transactions-drawer--editing" : ""}`} role="dialog" aria-label="Transaction details">
          <div className="transactions-drawer-header">
            <h3>{editing ? "Edit transaction" : "Transaction details"}</h3>
            <button
              type="button"
              className="transactions-drawer-close"
              onClick={closeDetailPanel}
            >
              ×
            </button>
          </div>

          <div className="transactions-drawer-body">
            {editing ? (
              renderEditForm(panelExpense, receiptUrl)
            ) : (
              <>
                {renderReceiptPreview(panelExpense, receiptUrl, "view")}

                <dl className="transactions-detail-list transactions-detail-list-simple">
                  <div>
                    <dt>Vendor</dt>
                    <dd>{vendorName(panelExpense)}</dd>
                  </div>
                  <div>
                    <dt>Amount</dt>
                    <dd className={amount.className}>{amount.text}</dd>
                  </div>
                  <div>
                    <dt>Date</dt>
                    <dd>{formatHumanDate(parseExpenseSortDate(panelExpense))}</dd>
                  </div>
                  <div>
                    <dt>2% fund</dt>
                    <dd>
                      {isTwoPercentFund(panelExpense) ? (
                        <TwoPercentColumnCell expense={panelExpense} />
                      ) : (
                        "No"
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Account</dt>
                    <dd>{panelExpense.bank_account_name || "—"}</dd>
                  </div>
                  <div>
                    <dt>Category</dt>
                    <dd>
                      <span className={`transactions-cat-pill ${categoryPillClass(panelExpense.category)}`}>
                        {categoryLabel(panelExpense)}
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
                  {(panelExpense.description || panelExpense.payment_reference) && (
                    <div>
                      <dt>Notes</dt>
                      <dd>{panelExpense.description || panelExpense.payment_reference}</dd>
                    </div>
                  )}
                </dl>

                <div className="transactions-similar-card">
                  <h4>Same vendor</h4>
                  {similarTransactions.length ? (
                    <ul>
                      {similarTransactions.map((item) => {
                        const itemAmount = formatTransactionAmount(item);
                        return (
                          <li key={item.id}>
                            <button
                              type="button"
                              className="transactions-similar-item"
                              onClick={() => {
                                setEditingId(null);
                                setSelectedId(item.id);
                              }}
                            >
                              <span>{formatHumanDate(parseExpenseSortDate(item))}</span>
                              <span className={itemAmount.className}>{itemAmount.text}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="muted">No other transactions for this vendor.</p>
                  )}
                </div>
              </>
            )}
          </div>
        </aside>
    );
  }

  return (
    <section className={`card transactions-page${panelExpense ? " has-drawer" : ""}`}>
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

      {uncategorizedTwoPct.length > 0 ? (
        <details
          className="transactions-2pct-cat-review"
          open={catReviewOpen}
          onToggle={(e) => setCatReviewOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary>
            <span>
              <strong>{uncategorizedTwoPct.length}</strong> 2% transaction
              {uncategorizedTwoPct.length === 1 ? "" : "s"} need a category
            </span>
            <button
              type="button"
              className="fb-secondary-btn transactions-2pct-apply-all"
              disabled={applyingAll}
              onClick={(e) => {
                e.preventDefault();
                void applyAllSuggestedCategories();
              }}
            >
              {applyingAll ? "Applying…" : "Apply all suggestions"}
            </button>
          </summary>
          <ul className="transactions-2pct-cat-list">
            {uncategorizedTwoPct.map((expense) => {
              const amount = formatTransactionAmount(expense);
              const options = Array.from(
                new Set([
                  pendingCategories[expense.id] || "Other 2% Expense",
                  ...twoPctCategoryOptions,
                ]),
              );
              return (
                <li key={expense.id} className="transactions-2pct-cat-row">
                  <div className="transactions-2pct-cat-meta">
                    <strong>{vendorName(expense)}</strong>
                    <span className="muted">
                      {formatHumanDate(parseExpenseSortDate(expense))} ·{" "}
                      <span className={amount.className}>{amount.text}</span>
                    </span>
                  </div>
                  <label className="transactions-2pct-cat-pick">
                    <span className="sr-only">Category for {vendorName(expense)}</span>
                    <select
                      value={pendingCategories[expense.id] || "Other 2% Expense"}
                      onChange={(e) =>
                        setPendingCategories((prev) => ({
                          ...prev,
                          [expense.id]: e.target.value,
                        }))
                      }
                    >
                      {options.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="fb-primary-btn"
                    disabled={applyingId === expense.id || applyingAll}
                    onClick={() => void applySuggestedCategory(expense.id)}
                  >
                    {applyingId === expense.id ? "…" : "Apply"}
                  </button>
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}

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
              <colgroup>
                <col className="transactions-col-date" />
                <col className="transactions-col-vendor" />
                <col className="transactions-col-category" />
                <col className="transactions-col-2pct" />
                <col className="transactions-col-account" />
                <col className="transactions-col-amount" />
                <col className="transactions-col-status" />
                <col className="transactions-col-actions" />
              </colgroup>
              <thead>
                <tr>
                  <th className="transactions-col-date">Date</th>
                  <th className="transactions-col-vendor">Vendor</th>
                  <th className="transactions-col-category">Category</th>
                  <th className="transactions-col-2pct">2%</th>
                  <th className="transactions-col-account">Account</th>
                  <th className="transactions-col-amount">Amount</th>
                  <th className="transactions-col-status">Status</th>
                  <th className="transactions-col-actions" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {displayExpenses.map((expense) => {
                  const amount = formatTransactionAmount(expense);
                  const status = transactionStatus(expense, receiptUrls, receiptRequests);
                  const isSelected = selectedId === expense.id;
                  return (
                    <tr
                      key={expense.id}
                      className={`transactions-row${isSelected ? " is-selected" : ""}${menuOpenId === expense.id ? " is-menu-open" : ""}`}
                      onClick={() => {
                        setEditingId(null);
                        setSelectedId(expense.id);
                      }}
                    >
                      <td className="transactions-col-date">
                        {formatTableDate(parseExpenseSortDate(expense))}
                      </td>
                      <td className="transactions-col-vendor">
                        <strong title={vendorName(expense)}>{vendorName(expense)}</strong>
                        {(expense.description || expense.payment_reference) && (
                          <span className="transactions-vendor-sub">
                            {expense.description || expense.payment_reference}
                          </span>
                        )}
                      </td>
                      <td className="transactions-col-category">
                        <span className={`transactions-cat-pill ${categoryPillClass(expense.category)}`}>
                          {categoryLabel(expense)}
                        </span>
                      </td>
                      <td className="transactions-col-2pct">
                        <TwoPercentColumnCell expense={expense} />
                      </td>
                      <td className="transactions-col-account" title={expense.bank_account_name || undefined}>
                        {expense.bank_account_name || "—"}
                      </td>
                      <td className={`transactions-col-amount ${amount.className}`}>{amount.text}</td>
                      <td className="transactions-col-status">
                        <span className={`transactions-status-pill transactions-status-${status.key}`}>
                          {status.label}
                        </span>
                      </td>
                      <td className="transactions-col-actions" onClick={(event) => event.stopPropagation()}>
                        {renderRowActions(expense)}
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
              const status = transactionStatus(expense, receiptUrls, receiptRequests);
              return (
                <article
                  key={expense.id}
                  className="transactions-mobile-card"
                  onClick={() => {
                    setEditingId(null);
                    setSelectedId(expense.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setEditingId(null);
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
                    <TwoPercentColumnCell expense={expense} />
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

      {panelExpense ? renderDetailPanel() : null}
    </section>
  );
}
