"use client";

import {
  ChangeEvent,
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Session, User } from "@supabase/supabase-js";
import { usePlaidLink } from "react-plaid-link";

import { bankStatementsBucket, receiptsBucket, supabase } from "../lib/supabase";
import {
  BankAccount,
  BankStatementExtraction,
  BankStatementUpload,
  Department,
  DepartmentCategory,
  DepartmentSetting,
  DepartmentMembership,
  DepartmentVendor,
  ExpenseDraft,
  ExpenseRecord,
  ExtractedReceiptData,
  OnboardingBeginningBalance,
  OnboardingPriorRecordUpload,
  OnboardingSuggestion,
  ROLE_OPTIONS,
  ReviewForm,
} from "../lib/types";
import {
  evaluateTwoPercentStatus,
  suggestTwoPctCategory,
  categoryTwoPercentStatus,
  TWO_PERCENT_STATUS_LABELS,
  TWO_PERCENT_STATUS_CLASS,
  TWO_PERCENT_DISCLAIMER,
  TWO_PERCENT_SUGGESTED_CATEGORIES,
  type TwoPercentStatus,
} from "../lib/two-percent-rules";
import { buildReconciliationReport, reconciliationReportCsv } from "../lib/reports";
import { ReconciliationInboxSection } from "./reconciliation-inbox";
import { TransactionsLedger } from "./TransactionsLedger";
import { NysFFReportPage } from "./nys-foreign-fire-report";
import { TaxFormFilingsSection } from "./tax-form-filings";

type AuthMode = "login" | "signup";
type AppView =
  | "dashboard"
  | "transactions"
  | "reconciliation"
  | "accounts"
  | "reports_documents"
  | "tax_forms"
  | "vendors"
  | "settings"
  | "new_expense";

type ReportsDocumentsMode = "hub" | "reconciliation" | "statements" | "two_percent_activity";
type MessageVariant = "success" | "error";

type ExpenseEntryLaunch = { tab: "receipt" | "manual" } | null;

const EMPTY_EXTRACTION: ExtractedReceiptData = {
  merchant_name: null,
  payee: null,
  transaction_date: null,
  total_amount: null,
  tax_amount: null,
  payment_reference: null,
  description: null,
  bank_account_name: null,
  balance_after_transaction: null,
  category: null,
  payment_method: null,
  extraction_status: "needs_review",
  confidence: 0,
  notes: null,
};

const today = new Date();
const defaultReportEnd = today.toISOString().slice(0, 10);
const defaultReportStart = `${today.getFullYear()}-01-01`;
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "dev";

const LEDGER_RECENT_LIMIT = 10;
const LEDGER_ALL_LIMIT = 5000;
type LedgerScope = "recent" | "all";

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

function formatMDYShort(y: number, month: number, day: number) {
  const yy = String(y).slice(-2);
  return `${month}/${day}/${yy}`;
}

function parseExpenseSortDate(expense: ExpenseRecord): string {
  const td = expense.transaction_date?.trim();
  if (td && /^\d{4}-\d{2}-\d{2}/.test(td)) return td.slice(0, 10);
  const c = expense.created_at?.slice(0, 10);
  if (c && /^\d{4}-\d{2}-\d{2}/.test(c)) return c;
  return "";
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

function normalizeRole(role: string) {
  const normalized = role.trim().toLowerCase();
  return ROLE_OPTIONS.find((option) => option.toLowerCase() === normalized) ?? null;
}

function loggedByLabel(user: User) {
  const name =
    user.user_metadata?.full_name != null ? String(user.user_metadata.full_name).trim() : "";
  const email = user.email || "";
  if (name && email) return `${name} (${email})`;
  return email || user.id;
}

function formatExpenseLoggedBy(expense: ExpenseRecord) {
  const raw = expense.uploaded_by?.trim();
  if (raw) return raw;
  return expense.created_by_email || "Unknown";
}

function formatUsd(amount: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(
    amount,
  );
}

function isExpenseInCurrentMonth(expense: ExpenseRecord) {
  const d = parseExpenseSortDate(expense);
  if (!d) return false;
  const now = new Date();
  const [yStr, mStr] = d.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  return y === now.getFullYear() && m === now.getMonth() + 1;
}

function buildTwoPercentSnapshot(
  expenses: ExpenseRecord[],
  bankAccounts: BankAccount[],
) {
  const twoPercentAccounts = bankAccounts.filter((a) => a.is_two_percent_account);
  if (!twoPercentAccounts.length) return null;

  const twoPercentAccountNames = new Set(twoPercentAccounts.map((a) => a.name.toLowerCase()));

  const twoPercentExpenses = expenses.filter(
    (expense) =>
      expense.uses_two_percent_funds ||
      (expense.bank_account_name &&
        twoPercentAccountNames.has(expense.bank_account_name.toLowerCase())),
  );

  const currentYear = new Date().getFullYear();
  let yearExpenses = 0;

  for (const expense of twoPercentExpenses) {
    const dateStr =
      expense.transaction_date?.slice(0, 4) || expense.created_at?.slice(0, 4);
    if (dateStr === String(currentYear)) {
      const amount =
        typeof expense.total_amount === "number"
          ? expense.total_amount
          : Number(String(expense.total_amount || "0").replace(/[$,]/g, "")) || 0;
      if (amount > 0) yearExpenses += amount;
    }
  }

  // Balance: use the most recent balance_after_transaction for the primary 2% account
  const primaryAccount = twoPercentAccounts[0];
  let latestBalance: number | null = null;
  if (primaryAccount) {
    const accountMatches = expenses
      .filter(
        (e) =>
          e.bank_account_name?.toLowerCase() === primaryAccount.name.toLowerCase() &&
          e.balance_after_transaction != null,
      )
      .sort((a, b) => {
        const da =
          a.transaction_date?.slice(0, 10) || a.created_at?.slice(0, 10) || "";
        const db =
          b.transaction_date?.slice(0, 10) || b.created_at?.slice(0, 10) || "";
        return db.localeCompare(da);
      });
    if (accountMatches.length) {
      const raw = accountMatches[0].balance_after_transaction;
      const parsed =
        typeof raw === "number" ? raw : Number(String(raw).replace(/[$,]/g, ""));
      if (Number.isFinite(parsed)) latestBalance = parsed;
    }
  }

  return {
    accounts: twoPercentAccounts,
    totalExpenses: twoPercentExpenses.length,
    yearExpenses,
    latestBalance,
    reportYear: currentYear,
  };
}

function buildDashboardMetrics(expenses: ExpenseRecord[]) {
  let totalRecorded = 0;
  let monthSpend = 0;
  let monthBankIn = 0;
  let monthBankOut = 0;
  let needsReview = 0;
  let openItems = 0;
  for (const expense of expenses) {
    const amt = expenseNumericAmount(expense.total_amount);
    if (amt != null) totalRecorded += Math.abs(amt);
    if (isExpenseInCurrentMonth(expense) && amt != null) monthSpend += Math.abs(amt);
    if (expense.extraction_status === "needs_review" || expense.extraction_status === "failed") needsReview += 1;
    if (
      expense.reconciliation_status === "pending_bank_match" ||
      expense.reconciliation_status === "unreconciled" ||
      expense.reconciliation_status === "needs_attention"
    ) {
      openItems += 1;
    }
    if (isExpenseInCurrentMonth(expense)) {
      const bankAmt = expenseNumericAmount(expense.bank_amount);
      if (bankAmt != null) {
        if (bankAmt >= 0) monthBankIn += bankAmt;
        else monthBankOut += Math.abs(bankAmt);
      }
    }
  }
  return { totalRecorded, monthSpend, monthBankIn, monthBankOut, needsReview, openItems };
}

type AccountSnapshot = {
  account: BankAccount;
  lastBalance: number | null;
  lastActivityDate: string | null;
};

function buildAccountSnapshots(
  bankAccounts: BankAccount[],
  expenses: ExpenseRecord[],
  beginningBalances?: OnboardingBeginningBalance[],
): AccountSnapshot[] {
  return bankAccounts.map((account) => {
    const matches = expenses
      .filter((expense) => (expense.bank_account_name || "").trim().toLowerCase() === account.name.trim().toLowerCase())
      .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    const latest = matches[0];
    const expenseBalance =
      latest && latest.balance_after_transaction != null && latest.balance_after_transaction !== ""
        ? expenseNumericAmount(latest.balance_after_transaction)
        : null;
    const openingBalance = beginningBalances?.find(
      (b) =>
        (b.account_id != null && b.account_id === account.id) ||
        normalizeName(b.account_name) === normalizeName(account.name),
    );
    const lastBalance = expenseBalance ?? (openingBalance ? openingBalance.beginning_balance : null);
    const lastActivityDate =
      latest?.transaction_date ||
      latest?.created_at?.slice(0, 10) ||
      (openingBalance ? openingBalance.balance_date : null);
    return { account, lastBalance, lastActivityDate };
  });
}

function expenseNeedsReconciliationAttention(expense: ExpenseRecord) {
  if (expense.reconciliation_status !== "matched") return true;
  if (expense.extraction_status === "needs_review" || expense.extraction_status === "failed") return true;
  if (expense.reconciliation_candidate) return true;
  return false;
}

type VendorAggregate = {
  key: string;
  label: string;
  count: number;
  totalSpend: number;
  lastUsed: string;
  topCategory: string | null;
};

function buildVendorAggregates(
  expenses: ExpenseRecord[],
  departmentVendors?: DepartmentVendor[],
): VendorAggregate[] {
  const map = new Map<
    string,
    { label: string; count: number; total: number; lastIso: string; categories: Map<string, number> }
  >();
  for (const expense of expenses) {
    const label = (expense.payee || expense.merchant_name || "").trim();
    if (!label) continue;
    const key = label.toLowerCase();
    const amt = expenseNumericAmount(expense.total_amount);
    const iso = parseExpenseSortDate(expense) || expense.created_at?.slice(0, 10) || "";
    const cat = (expense.category || "").trim();
    if (!map.has(key)) {
      map.set(key, { label, count: 0, total: 0, lastIso: "", categories: new Map() });
    }
    const row = map.get(key)!;
    row.count += 1;
    if (amt != null) row.total += Math.abs(amt);
    if (iso && iso > row.lastIso) row.lastIso = iso;
    if (cat) {
      row.categories.set(cat, (row.categories.get(cat) || 0) + 1);
    }
  }
  // Merge department vendors that have no expense history
  if (departmentVendors) {
    for (const dv of departmentVendors) {
      const key = dv.normalized_name;
      if (!map.has(key)) {
        const cats = new Map<string, number>();
        if (dv.default_category) cats.set(dv.default_category, 1);
        map.set(key, { label: dv.name, count: 0, total: 0, lastIso: "", categories: cats });
      } else if (dv.default_category) {
        const row = map.get(key)!;
        if (!row.categories.has(dv.default_category)) {
          row.categories.set(dv.default_category, 0);
        }
      }
    }
  }
  return [...map.values()].map((row) => {
    let topCategory: string | null = null;
    let topN = 0;
    for (const [c, n] of row.categories) {
      if (n > topN) {
        topN = n;
        topCategory = c;
      }
    }
    return {
      key: row.label.toLowerCase(),
      label: row.label,
      count: row.count,
      totalSpend: row.total,
      lastUsed: row.lastIso,
      topCategory,
    };
  });
}

const PRESET_EXPENSE_CATEGORIES = [
  "Fuel",
  "Supplies",
  "Food",
  "Training",
  "Equipment",
  "General",
  "Maintenance",
];

const PAYMENT_METHOD_OPTIONS = [
  { value: "credit_card", label: "Credit Card" },
  { value: "debit_card", label: "Debit Card" },
  { value: "check", label: "Check" },
  { value: "cash", label: "Cash" },
  { value: "ach", label: "ACH" },
  { value: "other", label: "Other" },
] as const;

function matchPaymentMethod(raw: string): string {
  const normalized = raw.trim().toLowerCase().replace(/[_-]+/g, " ");
  if (!normalized) return "";
  if (/credit/.test(normalized)) return "credit_card";
  if (/debit/.test(normalized)) return "debit_card";
  if (/check|cheque/.test(normalized)) return "check";
  if (/\bcash\b/.test(normalized)) return "cash";
  if (/ach|wire|transfer|eft/.test(normalized)) return "ach";
  for (const option of PAYMENT_METHOD_OPTIONS) {
    const valueLabel = option.value.replace(/_/g, " ");
    if (normalized === valueLabel || normalized === option.label.toLowerCase() || normalized === option.value) {
      return option.value;
    }
  }
  return "";
}

function amountStringToCents(value: string): number {
  const parsed = optionalNumber(value);
  if (parsed == null || parsed <= 0) return 0;
  return Math.round(parsed * 100);
}

function centsToAmountString(cents: number): string {
  if (cents <= 0) return "";
  return (cents / 100).toFixed(2);
}

function sortVendorSuggestions(vendors: VendorAggregate[]): VendorAggregate[] {
  return [...vendors].sort((a, b) => {
    const recentCmp = b.lastUsed.localeCompare(a.lastUsed);
    if (recentCmp !== 0) return recentCmp;
    const countCmp = b.count - a.count;
    if (countCmp !== 0) return countCmp;
    return a.label.localeCompare(b.label);
  });
}

function buildCategoryOptions(
  expenses: ExpenseRecord[],
  departmentCategories?: DepartmentCategory[],
): string[] {
  const seen = new Set(PRESET_EXPENSE_CATEGORIES.map((c) => c.toLowerCase()));
  const result: string[] = [...PRESET_EXPENSE_CATEGORIES];
  // Add department categories (from onboarding or manual) after presets
  if (departmentCategories) {
    for (const dc of departmentCategories) {
      const key = dc.normalized_name;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(dc.name);
      }
    }
  }
  // Add expense-derived categories at the end
  const historical: string[] = [];
  for (const expense of expenses) {
    const cat = (expense.category || "").trim();
    if (!cat) continue;
    const key = cat.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    historical.push(cat);
  }
  historical.sort((a, b) => a.localeCompare(b));
  return [...result, ...historical];
}

function suggestCategoryForVendor(
  vendor: string,
  expenses: ExpenseRecord[],
  departmentVendors?: DepartmentVendor[],
): string {
  const normalized = vendor.trim().toLowerCase();
  if (!normalized) return "";
  const matching = expenses.filter((expense) => {
    const label = (expense.payee || expense.merchant_name || "").trim().toLowerCase();
    return label === normalized && (expense.category || "").trim();
  });
  if (matching.length > 0) {
    matching.sort((a, b) => parseExpenseSortDate(b).localeCompare(parseExpenseSortDate(a)));
    const recentCategory = matching[0].category!.trim();
    const counts = new Map<string, number>();
    for (const expense of matching) {
      const cat = expense.category!.trim();
      counts.set(cat, (counts.get(cat) || 0) + 1);
    }
    let topCategory = recentCategory;
    let topCount = 0;
    for (const [cat, count] of counts) {
      if (count > topCount) {
        topCount = count;
        topCategory = cat;
      }
    }
    return topCount > 1 ? topCategory : recentCategory;
  }
  // Fall back to department vendor default category
  if (departmentVendors) {
    const dv = departmentVendors.find((v) => v.normalized_name === normalized);
    if (dv?.default_category) return dv.default_category;
  }
  return "";
}

function formatBankAccountLabel(account: BankAccount): string {
  const institution = account.institution_name?.trim();
  const mask = account.account_mask?.trim();
  const meta = [institution, mask ? `•••• ${mask}` : null].filter(Boolean).join(" ");
  return meta ? `${account.name} — ${meta}` : account.name;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function useDismissOnOutsideClick(
  ref: { current: HTMLElement | null },
  onDismiss: () => void,
  active: boolean,
) {
  useEffect(() => {
    if (!active) return;
    function handle(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onDismiss();
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [active, onDismiss, ref]);
}

type ManualExpenseFormValues = {
  transaction_date: string;
  payee: string;
  total_amount: number | null;
  payment_method: string;
  category: string;
  bank_account_name: string;
  description: string;
  uses_two_percent_funds: boolean;
  member_vote_recorded: boolean;
  meeting_date: string;
  support_note: string;
};

function VendorAutocompleteField({
  label,
  value,
  onChange,
  expenses,
  departmentVendors,
  required,
  placeholder = "Start typing a vendor",
  onVendorChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  expenses: ExpenseRecord[];
  departmentVendors?: DepartmentVendor[];
  required?: boolean;
  placeholder?: string;
  onVendorChange?: (vendor: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const prevVendorRef = useRef(value.trim().toLowerCase());

  const vendorSuggestions = useMemo(
    () => sortVendorSuggestions(buildVendorAggregates(expenses, departmentVendors)),
    [expenses, departmentVendors],
  );
  const filteredVendors = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return vendorSuggestions.slice(0, 8);
    return vendorSuggestions.filter((vendor) => vendor.label.toLowerCase().includes(q)).slice(0, 8);
  }, [value, vendorSuggestions]);

  useDismissOnOutsideClick(wrapRef, () => setOpen(false), open);

  function notifyVendorChange(nextVendor: string) {
    const normalized = nextVendor.trim().toLowerCase();
    if (!normalized || normalized === prevVendorRef.current) return;
    prevVendorRef.current = normalized;
    onVendorChange?.(nextVendor);
  }

  function applySuggestion(nextVendor: string) {
    onChange(nextVendor);
    setOpen(false);
    notifyVendorChange(nextVendor);
  }

  function handleBlur(event: { currentTarget: HTMLInputElement }) {
    const nextPayee = event.currentTarget.value;
    window.setTimeout(() => {
      setOpen(false);
      const normalized = nextPayee.trim().toLowerCase();
      if (!normalized || normalized === prevVendorRef.current) return;
      const known = vendorSuggestions.some((vendor) => vendor.label.toLowerCase() === normalized);
      if (!known) return;
      notifyVendorChange(nextPayee);
    }, 120);
  }

  return (
    <label>
      {label}
      <div className="fb-combobox" ref={wrapRef}>
        <input
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={handleBlur}
          required={required}
          autoComplete="off"
          placeholder={placeholder}
        />
        {open && filteredVendors.length > 0 ? (
          <ul className="fb-combobox-menu" role="listbox">
            {filteredVendors.map((vendor) => (
              <li key={vendor.key}>
                <button
                  type="button"
                  role="option"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applySuggestion(vendor.label)}
                >
                  <span className="fb-combobox-primary">{vendor.label}</span>
                  {vendor.topCategory ? <span className="fb-combobox-meta">{vendor.topCategory}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </label>
  );
}

/** Put 2% eligible categories at the top of the dropdown list. */
function reorderFor2Pct(options: string[]): string[] {
  const eligibleSet = new Set(
    TWO_PERCENT_SUGGESTED_CATEGORIES.filter((c) => c.status === "likely_eligible").map((c) => c.name.toLowerCase()),
  );
  const seedNames = TWO_PERCENT_SUGGESTED_CATEGORIES.filter((c) => c.status === "likely_eligible").map((c) => c.name);
  const existingLower = new Set(options.map((o) => o.toLowerCase()));
  const missing = seedNames.filter((n) => !existingLower.has(n.toLowerCase()));
  const twoFirst = options.filter((o) => eligibleSet.has(o.toLowerCase()));
  const rest = options.filter((o) => !eligibleSet.has(o.toLowerCase()));
  return [...missing, ...twoFirst, ...rest];
}

function CategoryComboboxField({
  label,
  value,
  onChange,
  expenses,
  departmentCategories,
  placeholder = "Fuel, supplies, food, training...",
  twoPctMode = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  expenses: ExpenseRecord[];
  departmentCategories?: DepartmentCategory[];
  placeholder?: string;
  twoPctMode?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const categoryOptions = useMemo(
    () => buildCategoryOptions(expenses, departmentCategories),
    [expenses, departmentCategories],
  );
  const filteredCategories = useMemo(() => {
    const allOpts = twoPctMode ? reorderFor2Pct(categoryOptions) : categoryOptions;
    const q = value.trim().toLowerCase();
    if (!q) return allOpts.slice(0, 12);
    return allOpts.filter((option) => option.toLowerCase().includes(q)).slice(0, 12);
  }, [value, categoryOptions, twoPctMode]);

  useDismissOnOutsideClick(wrapRef, () => setOpen(false), open);

  return (
    <label>
      {label}
      <div className="fb-combobox" ref={wrapRef}>
        <input
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          autoComplete="off"
          placeholder={placeholder}
        />
        {open && filteredCategories.length > 0 ? (
          <ul className="fb-combobox-menu" role="listbox">
            {filteredCategories.map((option) => (
              <li key={option}>
                <button
                  type="button"
                  role="option"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onChange(option);
                    setOpen(false);
                  }}
                >
                  {option}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </label>
  );
}

function TwoPercentFundBadge({ className }: { className?: string }) {
  return (
    <span className={`fb-2pct-badge fb-2pct-badge--fund ${className ?? ""}`} title="NYS Foreign Fire Insurance / 2% Funds Account">
      2% Funds
    </span>
  );
}

function TwoPercentStatusBadge({ status }: { status: TwoPercentStatus }) {
  return (
    <span className={`fb-2pct-badge ${TWO_PERCENT_STATUS_CLASS[status]}`}>
      {TWO_PERCENT_STATUS_LABELS[status]}
    </span>
  );
}

function TwoPercentGuidancePanel({
  vendor,
  category,
  description,
  memberVoteRecorded,
  meetingDate,
  supportNote,
  onMemberVoteChange,
  onMeetingDateChange,
  onSupportNoteChange,
}: {
  vendor: string;
  category: string;
  description: string;
  memberVoteRecorded: boolean;
  meetingDate: string;
  supportNote: string;
  onMemberVoteChange: (value: boolean) => void;
  onMeetingDateChange: (value: string) => void;
  onSupportNoteChange: (value: string) => void;
}) {
  const evaluation = useMemo(
    () => evaluateTwoPercentStatus({ vendor, category, description }),
    [vendor, category, description],
  );

  return (
    <div className="fb-2pct-panel">
      <div className="fb-2pct-panel-head">
        <TwoPercentFundBadge />
        {evaluation && <TwoPercentStatusBadge status={evaluation.status} />}
      </div>
      {evaluation ? (
        <p className="fb-2pct-reason">{evaluation.reason}</p>
      ) : (
        <p className="fb-2pct-reason muted">Enter vendor, category, or description to get guidance.</p>
      )}
      <p className="fb-2pct-disclaimer">{TWO_PERCENT_DISCLAIMER}</p>
      <div className="fb-2pct-support">
        <p className="fb-2pct-support-label">2% Fund Documentation (optional)</p>
        <div className="fb-2pct-support-grid">
          <label className="fb-settings-checkbox">
            <input
              type="checkbox"
              checked={memberVoteRecorded}
              onChange={(e) => onMemberVoteChange(e.target.checked)}
            />
            <span>Member vote recorded in minutes</span>
          </label>
          <label>
            Meeting date
            <input type="date" value={meetingDate} onChange={(e) => onMeetingDateChange(e.target.value)} />
          </label>
          <label>
            Support note / reference
            <input
              type="text"
              value={supportNote}
              onChange={(e) => onSupportNoteChange(e.target.value)}
              placeholder="Minutes reference, resolution #, etc."
            />
          </label>
        </div>
      </div>
    </div>
  );
}

function CentsMoneyInput({
  label,
  value,
  onChange,
  required,
  placeholder = "$0.00",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  placeholder?: string;
}) {
  const cents = amountStringToCents(value);

  return (
    <label>
      {label}
      <input
        inputMode="numeric"
        autoComplete="off"
        value={cents > 0 ? formatUsd(cents / 100) : ""}
        onChange={(event) => {
          const digits = event.target.value.replace(/\D/g, "");
          const nextCents = digits ? Number.parseInt(digits, 10) : 0;
          onChange(centsToAmountString(nextCents));
        }}
        required={required}
        placeholder={placeholder}
      />
    </label>
  );
}

function PaymentMethodSelect({
  label,
  value,
  onChange,
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)} required={required}>
        <option value="">Choose</option>
        {PAYMENT_METHOD_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function BankAccountSelect({
  label,
  value,
  onChange,
  bankAccounts,
  required,
  emptyMessage,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  bankAccounts: BankAccount[];
  required?: boolean;
  emptyMessage?: string;
}) {
  return (
    <label>
      {label}
      {bankAccounts.length ? (
        <select value={value} onChange={(event) => onChange(event.target.value)} required={required}>
          <option value="">Choose account</option>
          {bankAccounts.map((account) => (
            <option key={account.id} value={account.name}>
              {formatBankAccountLabel(account)}
              {account.is_default ? " (default)" : ""}
              {account.is_two_percent_account ? " · 2% Funds" : ""}
            </option>
          ))}
        </select>
      ) : (
        <p className="fb-field-hint">{emptyMessage || "Add an account in Settings before logging expenses."}</p>
      )}
    </label>
  );
}

function ManualExpenseForm({
  expenses,
  bankAccounts,
  defaultBankAccount,
  disabled,
  onSubmit,
  showTwoPercentPanel,
  departmentCategories,
  departmentVendors,
}: {
  expenses: ExpenseRecord[];
  bankAccounts: BankAccount[];
  defaultBankAccount: string;
  disabled: boolean;
  onSubmit: (values: ManualExpenseFormValues) => Promise<void>;
  showTwoPercentPanel?: boolean;
  departmentCategories?: DepartmentCategory[];
  departmentVendors?: DepartmentVendor[];
}) {
  const [payee, setPayee] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [category, setCategory] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [bankAccount, setBankAccount] = useState(defaultBankAccount);
  const [description, setDescription] = useState("");
  const [memberVoteRecorded, setMemberVoteRecorded] = useState(false);
  const [meetingDate, setMeetingDate] = useState("");
  const [supportNote, setSupportNote] = useState("");
  const [showMoreDetails, setShowMoreDetails] = useState(false);
  const [isTwoPctTagged, setIsTwoPctTagged] = useState(() => {
    const acct = bankAccounts.find((a) => a.name.toLowerCase() === defaultBankAccount.toLowerCase());
    return Boolean(acct?.is_two_percent_account);
  });

  const selectedAccount = useMemo(
    () => bankAccounts.find((a) => a.name.toLowerCase() === (bankAccount || "").toLowerCase()),
    [bankAccounts, bankAccount],
  );

  function handleBankAccountChange(newAccount: string) {
    setBankAccount(newAccount);
    const acct = bankAccounts.find((a) => a.name.toLowerCase() === newAccount.toLowerCase());
    setIsTwoPctTagged(Boolean(acct?.is_two_percent_account));
  }

  function handleTwoPctToggle(checked: boolean) {
    setIsTwoPctTagged(checked);
    if (checked) {
      const twoPctAcct = bankAccounts.find((a) => a.is_two_percent_account);
      if (twoPctAcct && bankAccount.toLowerCase() !== twoPctAcct.name.toLowerCase()) {
        setBankAccount(twoPctAcct.name);
      }
      if (!category) {
        const suggestion = suggestTwoPctCategory(payee) ?? suggestCategoryForVendor(payee, expenses, departmentVendors);
        if (suggestion) setCategory(suggestion);
      }
    }
  }

  function handleVendorChange(nextVendor: string) {
    const historySuggestion = suggestCategoryForVendor(nextVendor, expenses, departmentVendors);
    if (historySuggestion) {
      setCategory(historySuggestion);
    } else if (isTwoPctTagged) {
      const twoPctSuggestion = suggestTwoPctCategory(nextVendor);
      if (twoPctSuggestion) setCategory(twoPctSuggestion);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const amountCents = amountStringToCents(totalAmount);
    await onSubmit({
      transaction_date: String(form.get("transaction_date") || ""),
      payee: payee.trim(),
      total_amount: amountCents > 0 ? amountCents / 100 : null,
      payment_method: paymentMethod,
      category: category.trim(),
      bank_account_name: bankAccount.trim(),
      description: description.trim(),
      uses_two_percent_funds: isTwoPctTagged,
      member_vote_recorded: memberVoteRecorded,
      meeting_date: meetingDate,
      support_note: supportNote,
    });
  }

  return (
    <form className="upload-form fb-expense-form fb-new-expense-manual-form" onSubmit={handleSubmit}>
      {/* Core fields always visible */}
      <div className="form-grid two-column">
        <label>
          Date
          <input type="date" name="transaction_date" required defaultValue={formatLocalYMD(new Date())} />
        </label>
        <VendorAutocompleteField
          label="Vendor / payee"
          value={payee}
          onChange={setPayee}
          expenses={expenses}
          departmentVendors={departmentVendors}
          required
          onVendorChange={handleVendorChange}
        />
        <CentsMoneyInput label="Amount" value={totalAmount} onChange={setTotalAmount} required />
        <BankAccountSelect
          label="Bank / Credit account"
          value={bankAccount}
          onChange={handleBankAccountChange}
          bankAccounts={bankAccounts}
          required
          emptyMessage="Add an account in Settings before logging manual expenses."
        />
        <CategoryComboboxField label="Category" value={category} onChange={setCategory} expenses={expenses} departmentCategories={departmentCategories} twoPctMode={isTwoPctTagged} />
      </div>
      <div className="fb-2pct-tag-row">
        <label className="fb-2pct-tag-label">
          <input type="checkbox" checked={isTwoPctTagged} onChange={(e) => handleTwoPctToggle(e.target.checked)} />
          <span>Tag as 2% Funds expense</span>
          {isTwoPctTagged && <TwoPercentFundBadge className="fb-2pct-tag-badge" />}
        </label>
      </div>
      <label>
        Description
        <textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>

      {/* More details toggle */}
      <button
        type="button"
        className="fb-more-details-toggle link-button"
        onClick={() => setShowMoreDetails((v) => !v)}
      >
        {showMoreDetails ? "▲ Fewer details" : "▼ More details"}
      </button>

      {showMoreDetails && (
        <div className="fb-more-details form-grid two-column">
          <PaymentMethodSelect label="Payment type" value={paymentMethod} onChange={setPaymentMethod} />
          {isTwoPctTagged && showTwoPercentPanel && (
            <div className="form-grid-full">
              <TwoPercentGuidancePanel
                vendor={payee}
                category={category}
                description={description}
                memberVoteRecorded={memberVoteRecorded}
                meetingDate={meetingDate}
                supportNote={supportNote}
                onMemberVoteChange={setMemberVoteRecorded}
                onMeetingDateChange={setMeetingDate}
                onSupportNoteChange={setSupportNote}
              />
            </div>
          )}
        </div>
      )}

      <button
        type="submit"
        className="fb-primary-btn fb-new-expense-submit"
        disabled={disabled || !bankAccounts.length}
      >
        {disabled ? "Saving..." : "Save manual expense"}
      </button>
    </form>
  );
}

function NavGlyph({ children }: { children: ReactNode }) {
  return (
    <span className="fb-nav-glyph" aria-hidden>
      {children}
    </span>
  );
}

export default function Home() {
  const pathname = usePathname() || "";
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [membership, setMembership] = useState<DepartmentMembership | null>(null);
  const [expenses, setExpenses] = useState<ExpenseRecord[]>([]);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [departmentSettings, setDepartmentSettings] = useState<DepartmentSetting | null>(null);
  const [departmentCategories, setDepartmentCategories] = useState<DepartmentCategory[]>([]);
  const [departmentVendors, setDepartmentVendors] = useState<DepartmentVendor[]>([]);
  const [onboardingBeginningBalances, setOnboardingBeginningBalances] = useState<OnboardingBeginningBalance[]>([]);
  const [receiptUrls, setReceiptUrls] = useState<Record<string, string>>({});
  const [statementUrls, setStatementUrls] = useState<Record<string, string>>({});
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [view, setView] = useState<AppView>("dashboard");
  const [message, setMessage] = useState<string | null>(null);
  const [messageVariant, setMessageVariant] = useState<MessageVariant>("success");
  const [loading, setLoading] = useState(true);
  const [ledgerScope, setLedgerScope] = useState<LedgerScope>("recent");
  const [ledgerVendorQuery, setLedgerVendorQuery] = useState("");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [expenseEntryLaunch, setExpenseEntryLaunch] = useState<ExpenseEntryLaunch>(null);
  const [reportsDocumentsMode, setReportsDocumentsMode] = useState<ReportsDocumentsMode>("hub");
  const [ledgerBankAccountFilter, setLedgerBankAccountFilter] = useState("");
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>("overview");
  const transactionsPanelRef = useRef<HTMLDivElement | null>(null);
  const [useCompactAppHeader, setUseCompactAppHeader] = useState(false);
  const [showTwoPercentPanel, setShowTwoPercentPanel] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("fb_show_two_percent_panel") === "true";
  });

  const clearExpenseEntryLaunch = useCallback(() => setExpenseEntryLaunch(null), []);

  function showSuccessMessage(nextMessage: string | null) {
    setMessageVariant("success");
    setMessage(nextMessage);
  }

  function showErrorMessage(nextMessage: string) {
    setMessageVariant("error");
    setMessage(nextMessage);
  }

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(max-width: 900px)");
    function sync() {
      setUseCompactAppHeader(mq.matches);
    }
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    let mounted = true;

    async function loadSession() {
      const { data } = await supabase.auth.getSession();
      if (!mounted) return;
      setSession(data.session);
      if (data.session?.user) {
        await loadMembership(data.session.user);
      }
      setLoading(false);
    }

    loadSession();
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession?.user) {
        void loadMembership(nextSession.user).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Could not load your department access.";
          showErrorMessage(message);
          setMembership(null);
        });
      } else {
        setMembership(null);
        setExpenses([]);
        setReceiptUrls({});
        setLedgerScope("recent");
        setLedgerVendorQuery("");
      }
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  async function loadMembership(user: User) {
    const loadedMembership = await ensureMembership(user);
    if (!loadedMembership) {
      throw new Error(
        "Your account signed in, but it is not linked to a fire department yet. Contact your admin or complete signup again.",
      );
    }
    setMembership(loadedMembership);
    await Promise.all([
      loadDepartmentSettings(loadedMembership.department_id),
      loadBankAccounts(loadedMembership.department_id),
      loadDepartmentCategories(loadedMembership.department_id),
      loadDepartmentVendors(loadedMembership.department_id),
      loadOnboardingBeginningBalances(loadedMembership.department_id),
    ]);
  }

  async function loadDepartmentSettings(departmentId: string) {
    const { data, error } = await supabase
      .from("department_settings")
      .select("*")
      .eq("department_id", departmentId)
      .maybeSingle();
    if (error) {
      setDepartmentSettings(null);
      return;
    }
    setDepartmentSettings((data as DepartmentSetting | null) || null);
  }

  async function loadBankAccounts(departmentId: string) {
    const { data, error } = await supabase
      .from("bank_accounts")
      .select("*")
      .eq("department_id", departmentId)
      .order("created_at", { ascending: true });
    if (error) {
      if (!/bank_accounts|schema cache|does not exist/i.test(error.message)) {
        showErrorMessage(error.message);
      }
      setBankAccounts([]);
      return;
    }
    setBankAccounts((data || []) as BankAccount[]);
  }

  async function loadDepartmentCategories(departmentId: string) {
    const { data } = await supabase
      .from("department_categories")
      .select("*")
      .eq("department_id", departmentId)
      .order("name");
    setDepartmentCategories((data as DepartmentCategory[] | null) ?? []);
  }

  async function loadDepartmentVendors(departmentId: string) {
    const { data } = await supabase
      .from("department_vendors")
      .select("*")
      .eq("department_id", departmentId)
      .order("name");
    setDepartmentVendors((data as DepartmentVendor[] | null) ?? []);
  }

  async function loadOnboardingBeginningBalances(departmentId: string) {
    const { data } = await supabase
      .from("onboarding_beginning_balances")
      .select("*")
      .eq("department_id", departmentId);
    setOnboardingBeginningBalances((data as OnboardingBeginningBalance[] | null) ?? []);
  }

  async function refreshMembershipRow(user: User) {
    const { data } = await supabase
      .from("department_members")
      .select("department_id,role,departments(id,name,setup_completed_at)")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();
    if (data) {
      setMembership(data as unknown as DepartmentMembership);
    }
  }

  async function loadExpenses(departmentId: string) {
    setMessage(null);
    let query = supabase
      .from("expenses")
      .select("*")
      .eq("department_id", departmentId)
      .order("created_at", { ascending: false })
      .limit(LEDGER_ALL_LIMIT);
    const { data, error } = await query;

    if (error) {
      setMessage(error.message);
      return;
    }
    const loadedExpenses = (data || []) as ExpenseRecord[];
    setExpenses(loadedExpenses);
    await loadReceiptUrls(loadedExpenses);
  }

  useEffect(() => {
    if (!membership?.department_id) return;
    void loadExpenses(membership.department_id);
  }, [membership?.department_id]);

  async function loadStatementUrls(uploads: BankStatementUpload[]) {
    const entries = await Promise.all(
      uploads
        .filter((upload) => upload.statement_file_path)
        .map(async (upload) => {
          const { data } = await supabase.storage
            .from(bankStatementsBucket)
            .createSignedUrl(upload.statement_file_path as string, 60 * 60);
          return [upload.id, data?.signedUrl || ""] as const;
        }),
    );
    setStatementUrls(Object.fromEntries(entries.filter((entry) => entry[1])));
  }

  async function loadReceiptUrls(loadedExpenses: ExpenseRecord[]) {
    const batchSize = 40;
    const map: Record<string, string> = {};
    for (let i = 0; i < loadedExpenses.length; i += batchSize) {
      const slice = loadedExpenses.slice(i, i + batchSize);
      const entries = await Promise.all(
        slice.map(async (expense) => {
          try {
            const { data } = await supabase.storage
              .from(receiptsBucket)
              .createSignedUrl(expense.receipt_path, 60 * 60);
            return [expense.id, data?.signedUrl || ""] as const;
          } catch {
            return [expense.id, ""] as const;
          }
        }),
      );
      for (const [id, url] of entries) {
        if (url) map[id] = url;
      }
    }
    setReceiptUrls(map);
  }

  async function handleBankAccountsChanged() {
    if (!membership || !session?.user) return;
    await loadBankAccounts(membership.department_id);
    await refreshMembershipRow(session.user);
  }

  function submitHeaderSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setView("transactions");
    setLedgerScope("all");
    setLedgerBankAccountFilter("");
    setMobileNavOpen(false);
    window.setTimeout(() => {
      transactionsPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
  }

  function handleHeaderSearchInputChange(value: string) {
    setLedgerVendorQuery(value);
    if (!useCompactAppHeader) return;
    if (value.trim().length > 0) {
      setMobileNavOpen(false);
      setLedgerBankAccountFilter("");
      setLedgerScope("all");
      setView("transactions");
    }
  }

  function handleHeaderSearchFormSubmit(event: FormEvent<HTMLFormElement>) {
    if (useCompactAppHeader) {
      event.preventDefault();
      return;
    }
    submitHeaderSearch(event);
  }

  useEffect(() => {
    if (view === "transactions") {
      setLedgerScope("all");
    }
  }, [view]);

  useEffect(() => {
    if (view !== "reports_documents") {
      setReportsDocumentsMode("hub");
    }
  }, [view]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMobileNavOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileNavOpen]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [mobileNavOpen]);

  useEffect(() => {
    if (loading) return;
    if (pathname.startsWith("/app") && (!session || !membership)) {
      router.replace("/login");
    }
  }, [loading, pathname, session, membership, router]);

  useEffect(() => {
    if (loading) return;
    if (pathname.startsWith("/login") && session && membership) {
      router.replace("/app");
    }
  }, [loading, pathname, session, membership, router]);

  if (loading) {
    return (
      <div className="auth-page">
        <main className="auth-layout auth-layout--loading">
          <p className="auth-loading">Loading Firebook…</p>
        </main>
      </div>
    );
  }

  if (!session || !membership) {
    if (pathname.startsWith("/app")) {
      return (
        <div className="auth-page">
          <main className="auth-layout auth-layout--loading">
            <p className="auth-loading">Redirecting…</p>
          </main>
        </div>
      );
    }
    return (
      <AuthScreen
        mode={authMode}
        setMode={setAuthMode}
        onSignedIn={async (nextSession) => {
          setSession(nextSession);
          if (!nextSession.user) return;
          try {
            await loadMembership(nextSession.user);
          } catch (error) {
            await supabase.auth.signOut();
            const message =
              error instanceof Error ? error.message : "Could not load your department access.";
            showErrorMessage(message);
          }
        }}
        message={message}
        setMessage={setMessage}
      />
    );
  }

  if (session && membership && pathname.startsWith("/login")) {
    return (
      <div className="auth-page">
        <main className="auth-layout auth-layout--loading">
          <p className="auth-loading">Redirecting…</p>
        </main>
      </div>
    );
  }

  return (
    <div className="fb-app">
      <header className="fb-topbar">
        <div className="fb-topbar-left">
          <button
            type="button"
            className="fb-icon-button"
            aria-label="Open navigation menu"
            onClick={() => setMobileNavOpen(true)}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="fb-brand" aria-label="Firebook">
            <span className="fb-brand-mark">Fire</span>
            <span className="fb-brand-accent">book</span>
          </div>
        </div>

        <div className="fb-topbar-center">
          <form className="fb-topbar-search" onSubmit={handleHeaderSearchFormSubmit}>
            <label className="fb-visually-hidden" htmlFor="fb-global-search">
              Search transactions, vendors, accounts
            </label>
            <input
              id="fb-global-search"
              type="search"
              placeholder="Search transactions, vendors, accounts..."
              value={ledgerVendorQuery}
              onChange={(event) => handleHeaderSearchInputChange(event.target.value)}
              autoComplete="off"
            />
            <button type="submit" className="fb-topbar-search-submit">
              Search
            </button>
          </form>
          <button
            type="button"
            className="fb-topbar-new-expense"
            onClick={() => {
              setExpenseEntryLaunch({ tab: "receipt" });
              setView("new_expense");
              setMobileNavOpen(false);
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
            New Expense
          </button>
        </div>

        <div className="fb-topbar-user">
          <div className="fb-user-chip">
            <div className="fb-user-chip-text">
              <strong>{membership.departments?.name || "Fire Department"}</strong>
              <span className="fb-user-chip-email">{session.user.email}</span>
              <span className="fb-user-chip-role">{membership.role}</span>
            </div>
          </div>
          <button type="button" className="fb-topbar-logout" onClick={() => void supabase.auth.signOut()}>
            Log out
          </button>
        </div>
      </header>

      <div className="fb-app-body">
        {mobileNavOpen ? (
          <button
            type="button"
            className="fb-nav-overlay"
            aria-label="Close navigation menu"
            onClick={() => setMobileNavOpen(false)}
          />
        ) : null}

        <aside className={`fb-sidebar ${mobileNavOpen ? "fb-sidebar--open" : ""}`} aria-label="Sidebar">
          <div className="fb-sidebar-inner">
            <div className="fb-sidebar-mobile-head">
              <span className="fb-sidebar-mobile-title">Menu</span>
              <button
                type="button"
                className="fb-icon-button"
                aria-label="Close navigation menu"
                onClick={() => setMobileNavOpen(false)}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <nav className="fb-sidebar-nav" aria-label="Primary">
              <button
                type="button"
                className={`fb-sidebar-link ${view === "dashboard" ? "fb-sidebar-link-active" : ""}`}
                onClick={() => {
                  setView("dashboard");
                  setMobileNavOpen(false);
                }}
              >
                <NavGlyph>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5Z" />
                  </svg>
                </NavGlyph>
                <span className="fb-sidebar-link-label">Dashboard</span>
              </button>
              <button
                type="button"
                className={`fb-sidebar-link ${view === "transactions" ? "fb-sidebar-link-active" : ""}`}
                onClick={() => {
                  setView("transactions");
                  setLedgerBankAccountFilter("");
                  setMobileNavOpen(false);
                }}
              >
                <NavGlyph>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M4 6h16M4 12h16M4 18h10" />
                  </svg>
                </NavGlyph>
                <span className="fb-sidebar-link-label">Transactions</span>
              </button>
              <button
                type="button"
                className={`fb-sidebar-link ${view === "reconciliation" ? "fb-sidebar-link-active" : ""}`}
                onClick={() => {
                  setView("reconciliation");
                  setMobileNavOpen(false);
                }}
              >
                <NavGlyph>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                  </svg>
                </NavGlyph>
                <span className="fb-sidebar-link-label">Reconciliation</span>
              </button>
              <button
                type="button"
                className={`fb-sidebar-link ${view === "accounts" ? "fb-sidebar-link-active" : ""}`}
                onClick={() => {
                  setView("accounts");
                  setMobileNavOpen(false);
                }}
              >
                <NavGlyph>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 10h18v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V10Z" />
                    <path d="M7 10V7a5 5 0 0 1 10 0v3" />
                  </svg>
                </NavGlyph>
                <span className="fb-sidebar-link-label">Accounts</span>
              </button>
              <button
                type="button"
                className={`fb-sidebar-link ${view === "reports_documents" ? "fb-sidebar-link-active" : ""}`}
                onClick={() => {
                  setView("reports_documents");
                  setReportsDocumentsMode("hub");
                  setMobileNavOpen(false);
                }}
              >
                <NavGlyph>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M7 3h8l3 3v15H7V3Z" />
                    <path d="M14 3v4h4M9 13h6M9 17h6" />
                  </svg>
                </NavGlyph>
                <span className="fb-sidebar-link-label">Reports &amp; Documents</span>
              </button>
              <button
                type="button"
                className={`fb-sidebar-link ${view === "tax_forms" ? "fb-sidebar-link-active" : ""}`}
                onClick={() => {
                  setView("tax_forms");
                  setMobileNavOpen(false);
                }}
              >
                <NavGlyph>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z" />
                    <path d="M14 2v6h6M8 13h8M8 17h8" />
                  </svg>
                </NavGlyph>
                <span className="fb-sidebar-link-label">Tax Forms</span>
              </button>
              <button
                type="button"
                className={`fb-sidebar-link ${view === "vendors" ? "fb-sidebar-link-active" : ""}`}
                onClick={() => {
                  setView("vendors");
                  setMobileNavOpen(false);
                }}
              >
                <NavGlyph>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                </NavGlyph>
                <span className="fb-sidebar-link-label">Vendors</span>
              </button>

              <div className="fb-sidebar-divider" />

              <div className="fb-sidebar-settings-group">
                <button
                  type="button"
                  className={`fb-sidebar-link ${view === "settings" ? "fb-sidebar-link-active" : ""}`}
                  onClick={() => {
                    setView("settings");
                    setMobileNavOpen(false);
                  }}
                >
                  <NavGlyph>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c0 .66.39 1.26 1 1.51H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
                    </svg>
                  </NavGlyph>
                  <span className="fb-sidebar-link-label">Settings</span>
                </button>
                {view === "settings" ? (
                  <div className="fb-sidebar-subnav" role="group" aria-label="Settings sections">
                    {SETTINGS_NAV.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={`fb-sidebar-sublink ${settingsSection === item.id ? "fb-sidebar-sublink-active" : ""}`}
                        onClick={() => {
                          setView("settings");
                          setSettingsSection(item.id);
                          setMobileNavOpen(false);
                        }}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </nav>

            <div className="fb-sidebar-meta">
              <div className="fb-sidebar-progress">
                <ReconciliationProgress expenses={expenses} />
              </div>
            </div>

            <div className="fb-sidebar-footer">
              <p className="fb-sidebar-dept">{membership.departments?.name || "Fire Department"}</p>
              <p className="fb-sidebar-email">{session.user.email}</p>
              <p className="fb-sidebar-role">{membership.role}</p>
              <button type="button" className="fb-sidebar-signout" onClick={() => void supabase.auth.signOut()}>
                Sign out
              </button>
            </div>
          </div>
        </aside>

        <div className="fb-main">
          {message ? (
            <div className={`fb-banner notice ${messageVariant === "error" ? "notice-error" : ""}`}>{message}</div>
          ) : null}

          {view === "dashboard" ? (
            <Dashboard
              membership={membership}
              user={session.user}
              expenses={expenses}
              bankAccounts={bankAccounts}
              onNavigateView={(next) => {
                setView(next);
                setMobileNavOpen(false);
              }}
              onOpenReportsPanel={(panel) => {
                setView("reports_documents");
                setReportsDocumentsMode(panel === "reconciliation" ? "reconciliation" : "statements");
                setMobileNavOpen(false);
              }}
              onOpenNewExpense={(tab) => {
                setExpenseEntryLaunch({ tab });
                setView("new_expense");
                setMobileNavOpen(false);
              }}
            />
          ) : view === "new_expense" ? (
            <NewExpensePage
              membership={membership}
              user={session.user}
              expenses={expenses}
              bankAccounts={bankAccounts}
              launchTab={expenseEntryLaunch}
              onLaunchConsumed={clearExpenseEntryLaunch}
              onExpensesChanged={() => loadExpenses(membership.department_id)}
              setMessage={setMessage}
              showSuccessMessage={showSuccessMessage}
              showErrorMessage={showErrorMessage}
              showTwoPercentPanel={showTwoPercentPanel}
              departmentCategories={departmentCategories}
              departmentVendors={departmentVendors}
            />
          ) : view === "transactions" ? (
            <div ref={transactionsPanelRef} className="fb-tab-stack">
              <TransactionsLedger
                expenses={expenses}
                receiptUrls={receiptUrls}
                user={session.user}
                onExpensesChanged={() => loadExpenses(membership.department_id)}
                showErrorMessage={showErrorMessage}
                showSuccessMessage={showSuccessMessage}
                vendorQuery={ledgerVendorQuery}
                onVendorQueryChange={setLedgerVendorQuery}
                ledgerMayTruncate={expenses.length >= LEDGER_ALL_LIMIT}
                bankAccountFilter={ledgerBankAccountFilter}
                onClearBankAccountFilter={() => setLedgerBankAccountFilter("")}
              />
            </div>
          ) : view === "reconciliation" ? (
            <ReconciliationInboxSection
              expenses={expenses}
              receiptUrls={receiptUrls}
              bankAccounts={bankAccounts}
              membership={membership}
              user={session.user}
              onExpensesChanged={() => loadExpenses(membership.department_id)}
              showErrorMessage={showErrorMessage}
              showSuccessMessage={showSuccessMessage}
              onOpenFullReport={() => {
                setView("reports_documents");
                setReportsDocumentsMode("reconciliation");
                setMobileNavOpen(false);
              }}
              onOpenUploadStatement={() => {
                setView("reports_documents");
                setReportsDocumentsMode("statements");
                setMobileNavOpen(false);
              }}
              onOpenTransactions={() => {
                setView("transactions");
                setLedgerBankAccountFilter("");
                setMobileNavOpen(false);
              }}
              onOpenNewExpense={() => {
                setExpenseEntryLaunch({ tab: "receipt" });
                setView("new_expense");
                setMobileNavOpen(false);
              }}
            />
          ) : view === "accounts" ? (
            <AccountsTabSection
              bankAccounts={bankAccounts}
              expenses={expenses}
              beginningBalances={onboardingBeginningBalances}
              onViewAccountTransactions={(accountName) => {
                setLedgerBankAccountFilter(accountName);
                setView("transactions");
                setMobileNavOpen(false);
              }}
              onBankAccountsChanged={handleBankAccountsChanged}
            />
          ) : view === "reports_documents" ? (
            <ReportsDocumentsSection
              mode={reportsDocumentsMode}
              setMode={setReportsDocumentsMode}
              membership={membership}
              user={session.user}
              departmentName={membership.departments?.name || "Fire Department"}
              expenses={expenses}
              receiptUrls={receiptUrls}
              bankAccounts={bankAccounts}
              departmentSettings={departmentSettings}
              statementUrls={statementUrls}
              onExpensesChanged={() => loadExpenses(membership.department_id)}
              onStatementUrlsChanged={loadStatementUrls}
              showErrorMessage={showErrorMessage}
              showSuccessMessage={showSuccessMessage}
            />
          ) : view === "tax_forms" ? (
            <TaxFormsSection membership={membership} expenses={expenses} bankAccounts={bankAccounts} />
          ) : view === "vendors" ? (
            <VendorsSection expenses={expenses} departmentVendors={departmentVendors} />
          ) : view === "settings" ? (
            <Settings
              membership={membership}
              session={session}
              user={session.user}
              bankAccounts={bankAccounts}
              expenses={expenses}
              departmentSettings={departmentSettings}
              departmentCategories={departmentCategories}
              activeSection={settingsSection}
              onSectionChange={setSettingsSection}
              onBankAccountsChanged={handleBankAccountsChanged}
              onDepartmentSettingsChanged={() => loadDepartmentSettings(membership.department_id)}
              onCategoriesChanged={() => loadDepartmentCategories(membership.department_id)}
              onVendorsChanged={() => loadDepartmentVendors(membership.department_id)}
              onBeginningBalancesChanged={() => loadOnboardingBeginningBalances(membership.department_id)}
              showErrorMessage={showErrorMessage}
              showSuccessMessage={showSuccessMessage}
              showTwoPercentPanel={showTwoPercentPanel}
              onTwoPercentPanelToggle={(v) => {
                setShowTwoPercentPanel(v);
                if (typeof window !== "undefined") {
                  localStorage.setItem("fb_show_two_percent_panel", String(v));
                }
              }}
            />
          ) : null}
        </div>
      </div>

      <footer className="app-version fb-app-version">App version: {APP_VERSION}</footer>
    </div>
  );
}

function AuthScreen({
  mode,
  setMode,
  onSignedIn,
  message,
  setMessage,
}: {
  mode: AuthMode;
  setMode: (mode: AuthMode) => void;
  onSignedIn: (session: Session) => Promise<void>;
  message: string | null;
  setMessage: (message: string | null) => void;
}) {
  return (
    <div className="auth-page">
      <main className="auth-layout">
        <section className="card auth-card">
          <div className="firebook-brand" aria-label="Firebook">
            <span className="firebook-brand__wordmark">Firebook</span>
            <span className="firebook-brand__tagline">Fire department bookkeeping</span>
          </div>
          <h1 className="auth-title">{mode === "login" ? "Log in to your department" : "Create your account"}</h1>
          <p className="auth-lede">
            {mode === "login"
              ? "Sign in to see your department dashboard, receipts, expenses, and reports."
              : "Choose your fire department, enter your contact information and the access code from your administrator, then create your login."}
          </p>
          {message && <div className="notice notice-error">{message}</div>}
          {mode === "login" ? (
            <LoginForm onSignedIn={onSignedIn} setMessage={setMessage} />
          ) : (
            <SignupForm onSignedIn={onSignedIn} setMessage={setMessage} />
          )}
          <p className="auth-switch">
            {mode === "login" ? "Need an account? " : "Already have an account? "}
            <button
              className="link-button auth-switch-button"
              type="button"
              onClick={() => {
                setMessage(null);
                setMode(mode === "login" ? "signup" : "login");
              }}
            >
              {mode === "login" ? "Create one for your department" : "Log in"}
            </button>
          </p>
        </section>
      </main>
    </div>
  );
}

function LoginForm({
  onSignedIn,
  setMessage,
}: {
  onSignedIn: (session: Session) => Promise<void>;
  setMessage: (message: string | null) => void;
}) {
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotMessage, setForgotMessage] = useState<string | null>(null);
  const [forgotIsError, setForgotIsError] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setLoginLoading(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") || "").trim();
    const password = String(form.get("password") || "");
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error || !data.session) {
        setMessage(error?.message || "Could not sign in.");
        return;
      }
      await onSignedIn(data.session);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not complete sign-in for this account.";
      setMessage(message);
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleForgotSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setForgotMessage(null);
    setForgotLoading(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("reset_email") || "").trim();
    if (!email) {
      setForgotIsError(true);
      setForgotMessage("Enter your email address.");
      setForgotLoading(false);
      return;
    }
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) {
        setForgotIsError(true);
        setForgotMessage(error.message);
        return;
      }
      setForgotIsError(false);
      setForgotMessage("Check your email for a password reset link.");
    } catch (error) {
      setForgotIsError(true);
      setForgotMessage(
        error instanceof Error ? error.message : "Could not send password reset email.",
      );
    } finally {
      setForgotLoading(false);
    }
  }

  if (showForgotPassword) {
    return (
      <form onSubmit={handleForgotSubmit} className="upload-form">
        <p className="muted">Enter the email for your account and we will send a reset link.</p>
        {forgotMessage ? (
          <div className={forgotIsError ? "notice notice-error" : "notice"} role={forgotIsError ? "alert" : "status"}>
            {forgotMessage}
          </div>
        ) : null}
        <label>
          Email
          <input type="email" name="reset_email" autoComplete="email" required disabled={forgotLoading} />
        </label>
        <button type="submit" disabled={forgotLoading}>
          {forgotLoading ? "Sending…" : "Send reset link"}
        </button>
        <p className="auth-switch">
          <button
            className="link-button auth-switch-button"
            type="button"
            disabled={forgotLoading}
            onClick={() => {
              setShowForgotPassword(false);
              setForgotMessage(null);
            }}
          >
            Back to log in
          </button>
        </p>
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="upload-form">
      <label>
        Email
        <input type="email" name="email" autoComplete="email" required disabled={loginLoading} />
      </label>
      <label>
        Password
        <input type="password" name="password" autoComplete="current-password" required disabled={loginLoading} />
      </label>
      <p className="muted" style={{ margin: "-8px 0 0", textAlign: "right" }}>
        <button
          className="link-button"
          type="button"
          disabled={loginLoading}
          onClick={() => {
            setMessage(null);
            setForgotMessage(null);
            setShowForgotPassword(true);
          }}
        >
          Forgot password?
        </button>
      </p>
      <button type="submit" disabled={loginLoading}>
        {loginLoading ? "Logging in…" : "Log in"}
      </button>
    </form>
  );
}

function SignupForm({
  onSignedIn,
  setMessage,
}: {
  onSignedIn: (session: Session) => Promise<void>;
  setMessage: (message: string | null) => void;
}) {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [selectedDepartment, setSelectedDepartment] = useState<Department | null>(null);
  const [departmentText, setDepartmentText] = useState("");

  useEffect(() => {
    searchDepartments("");
  }, []);

  async function searchDepartments(query: string) {
    const { data, error } = await supabase
      .from("departments")
      .select("id,name")
      .ilike("name", `%${query}%`)
      .order("name", { ascending: true })
      .limit(10);
    if (!error) {
      setDepartments((data || []) as Department[]);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    if (!selectedDepartment) {
      setMessage("Choose a department from the list.");
      return;
    }

    const form = new FormData(event.currentTarget);
    const fullName = String(form.get("full_name") || "").trim();
    const phone = String(form.get("phone") || "").trim();
    const email = String(form.get("email") || "").trim();
    const password = String(form.get("password") || "");
    const inviteCode = String(form.get("department_invite_code") || "");
    const role = normalizeRole(String(form.get("role") || ""));
    if (!fullName) {
      setMessage("Enter your name.");
      return;
    }
    if (!phone) {
      setMessage("Enter your phone number so the department can reach you.");
      return;
    }
    if (!role) {
      setMessage("Choose a valid role.");
      return;
    }
    if (!inviteCode.trim()) {
      setMessage("Enter the department access code your administrator gave you.");
      return;
    }

    const verifyResponse = await fetch("/api/verify-department-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ departmentId: selectedDepartment.id, inviteCode: inviteCode.trim() }),
    });
    const verifyPayload = (await verifyResponse.json()) as { ok?: boolean; error?: string };
    if (!verifyResponse.ok || !verifyPayload.ok) {
      setMessage(verifyPayload.error || "Invalid department access code.");
      return;
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          phone,
          pending_department_id: selectedDepartment.id,
          pending_department_name: selectedDepartment.name,
          pending_department_role: role,
        },
      },
    });

    if (error) {
      setMessage(error.message);
      return;
    }
    if (!data.session) {
      setMessage("Account created. Confirm your email, then log in to finish setup.");
      return;
    }

    const membership = await createMembershipFromMetadata(data.user, role, selectedDepartment);
    if (!membership) {
      setMessage(
        "Account created, but department access could not be finished. Try logging in again or contact an administrator.",
      );
      return;
    }
    await onSignedIn(data.session);
  }

  return (
    <form onSubmit={handleSubmit} className="upload-form">
      <label>
        Department
        <select
          value={selectedDepartment?.id || ""}
          onChange={(event) => {
            const id = event.target.value;
            const match = departments.find((d) => d.id === id) || null;
            setSelectedDepartment(match);
            setDepartmentText(match?.name || "");
          }}
        >
          <option value="">Choose your fire department</option>
          {departments.map((department) => (
            <option key={department.id} value={department.id}>
              {department.name}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">Or type to search</p>
      <label>
        Search departments
        <input
          type="text"
          list="department-options"
          value={departmentText}
          onChange={(event) => {
            const value = event.target.value;
            setDepartmentText(value);
            const match = departments.find((department) => department.name === value) || null;
            setSelectedDepartment(match);
            if (value.length >= 2) searchDepartments(value);
          }}
          autoComplete="organization"
          placeholder="Start typing your fire department"
        />
        <datalist id="department-options">
          {departments.map((department) => (
            <option key={department.id} value={department.name} />
          ))}
        </datalist>
      </label>
      <label>
        Full name
        <input type="text" name="full_name" autoComplete="name" required />
      </label>
      <label>
        Phone number
        <input type="tel" name="phone" autoComplete="tel" required />
      </label>
      <label>
        Email
        <input type="email" name="email" autoComplete="email" required />
      </label>
      <label>
        Password (your login password)
        <input type="password" name="password" autoComplete="new-password" required />
      </label>
      <label>
        Department access code (from your administrator)
        <input
          type="password"
          name="department_invite_code"
          autoComplete="off"
          placeholder="Unique code for your fire department"
          required
        />
      </label>
      <label>
        Role
        <select name="role" required>
          <option value="">Choose your role</option>
          {ROLE_OPTIONS.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
      </label>
      <button type="submit">Create account</button>
    </form>
  );
}

function DepartmentSetupBanner({
  membership,
  user,
  bankAccounts,
}: {
  membership: DepartmentMembership;
  user: User;
  bankAccounts: BankAccount[];
}) {
  const [isFirstMember, setIsFirstMember] = useState(false);
  const [hasPlaid, setHasPlaid] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      const { data: first } = await supabase
        .from("department_members")
        .select("user_id")
        .eq("department_id", membership.department_id)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      const { data: plaidRows } = await supabase
        .from("plaid_items")
        .select("id")
        .eq("department_id", membership.department_id)
        .limit(1);
      if (!cancelled) {
        setIsFirstMember(Boolean(first?.user_id === user.id));
        setHasPlaid(Boolean(plaidRows?.length));
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [membership.department_id, user.id]);

  const setupComplete = Boolean(membership.departments?.setup_completed_at);
  const hasFinancialSetup = bankAccounts.length > 0 || hasPlaid;

  if (setupComplete || hasFinancialSetup) {
    return (
      <div className="integration-note">
        All expenses and bank settings are shared across everyone in{" "}
        <strong>{membership.departments?.name || "your department"}</strong>.
      </div>
    );
  }

  if (isFirstMember) {
    return (
      <div className="notice notice-error">
        You are the first user for this department. Open <strong>Settings</strong> and connect Plaid or add at least one bank
        account. Later members will use the same configuration and see the same expense ledger.
      </div>
    );
  }

  return (
    <div className="notice">
      The first person who registered for this department still needs to finish <strong>Settings</strong> (bank accounts / Plaid).
      You all share one expense ledger.
    </div>
  );
}

function TaxFormsSection({
  membership,
  expenses,
  bankAccounts,
}: {
  membership: DepartmentMembership;
  expenses: ExpenseRecord[];
  bankAccounts: BankAccount[];
}) {
  const [mode, setMode] = useState<"hub" | "nys_foreign_fire">("hub");
  // Bump when returning from the report builder so the filings list refreshes
  const [filingsKey, setFilingsKey] = useState(0);

  if (mode === "nys_foreign_fire") {
    return (
      <NysFFReportPage
        membership={membership}
        expenses={expenses}
        bankAccounts={bankAccounts}
        onBack={() => {
          setMode("hub");
          setFilingsKey((k) => k + 1);
        }}
      />
    );
  }

  const comingSoon = [
    { title: "IRS Form 990", desc: "Nonprofit disclosure package preparation (coming soon)." },
    { title: "Year-end tax package", desc: "Exportable binder for your accountant (coming soon)." },
  ];

  return (
    <div className="fb-tab-stack">
      <section className="card fb-dash-welcome">
        <p className="eyebrow">Compliance</p>
        <h1 className="fb-dash-title">Tax Forms</h1>
        <p className="fb-dash-subtitle">
          Generate New York State filings directly from your Firebook transaction data. Select a report to get started.
        </p>
      </section>

      <div className="fb-doc-hub-grid">
        {/* NYS Foreign Fire Insurance Report — live */}
        <div className="fb-doc-hub-card fb-doc-hub-card--primary">
          <div className="nys-card-badge">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
              <path d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            Ready
          </div>
          <h2>NYS Foreign Fire Insurance Report (2%)</h2>
          <p className="muted">
            Generate the Annual Report of Foreign Fire Insurance Premiums using your Firebook transaction data. Includes OCR extraction from prior year filings.
            {bankAccounts.some((a) => a.is_two_percent_account)
              ? " Financial figures auto-populate from your tagged 2% account."
              : " Tag a 2% account in Settings → Bank Accounts to enable auto-population."}
          </p>
          <button
            type="button"
            className="fb-primary-btn nys-card-btn"
            onClick={() => setMode("nys_foreign_fire")}
          >
            Open Report Builder
          </button>
        </div>

        {/* Coming-soon cards */}
        {comingSoon.map((item) => (
          <div key={item.title} className="fb-doc-hub-card">
            <h2>{item.title}</h2>
            <p className="muted">{item.desc}</p>
            <button type="button" className="fb-secondary-btn" disabled>
              Prepare (soon)
            </button>
          </div>
        ))}
      </div>

      {/* Previous filings */}
      <TaxFormFilingsSection membership={membership} refreshKey={filingsKey} />
    </div>
  );
}

type VendorSort = "recent" | "count" | "spend" | "category";

function VendorsSection({
  expenses,
  departmentVendors,
}: {
  expenses: ExpenseRecord[];
  departmentVendors?: DepartmentVendor[];
}) {
  const [sort, setSort] = useState<VendorSort>("spend");
  const rows = useMemo(() => {
    const list = buildVendorAggregates(expenses, departmentVendors);
    const sorted = [...list];
    if (sort === "count") sorted.sort((a, b) => b.count - a.count);
    else if (sort === "spend") sorted.sort((a, b) => b.totalSpend - a.totalSpend);
    else if (sort === "recent") sorted.sort((a, b) => b.lastUsed.localeCompare(a.lastUsed));
    else sorted.sort((a, b) => (a.topCategory || "").localeCompare(b.topCategory || ""));
    return sorted;
  }, [expenses, sort]);

  return (
    <div className="fb-tab-stack">
      <section className="card fb-dash-welcome">
        <p className="eyebrow">Directory</p>
        <h1 className="fb-dash-title">Vendors</h1>
        <p className="fb-dash-subtitle">
          Vendors from logged expenses and onboarding setup. Sorting helps treasurers see who you
          pay most often.
        </p>
      </section>
      <section className="card">
        <div className="fb-vendor-toolbar">
          <span className="muted">Sort by</span>
          <div className="fb-chip-row">
            {(
              [
                ["spend", "Total spend"],
                ["count", "Most used"],
                ["recent", "Most recent"],
                ["category", "Category A–Z"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`fb-chip ${sort === key ? "fb-chip-active" : ""}`}
                onClick={() => setSort(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {rows.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th>Transactions</th>
                  <th>Total spend</th>
                  <th>Top category</th>
                  <th>Last activity</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td>{row.label}</td>
                    <td>{row.count}</td>
                    <td>{formatUsd(row.totalSpend)}</td>
                    <td>{row.topCategory || "—"}</td>
                    <td>{row.lastUsed || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-state">
            No vendors yet. Vendors appear from logged expenses and from accepted vendor suggestions in Settings → Onboarding.
          </p>
        )}
      </section>
    </div>
  );
}

function AccountsTabSection({
  bankAccounts,
  expenses,
  beginningBalances,
  onViewAccountTransactions,
  onBankAccountsChanged,
}: {
  bankAccounts: BankAccount[];
  expenses: ExpenseRecord[];
  beginningBalances?: OnboardingBeginningBalance[];
  onViewAccountTransactions: (accountName: string) => void;
  onBankAccountsChanged: () => Promise<void>;
}) {
  const snapshots = useMemo(
    () => buildAccountSnapshots(bankAccounts, expenses, beginningBalances),
    [bankAccounts, expenses, beginningBalances],
  );
  return (
    <div className="fb-tab-stack">
      <section className="card fb-dash-welcome">
        <p className="eyebrow">Cash & credit</p>
        <h1 className="fb-dash-title">Accounts</h1>
        <p className="fb-dash-subtitle">
          Department bank and card accounts. Balances reflect the latest register total on an
          expense, or the onboarding beginning balance when no activity exists yet.
        </p>
      </section>
      {snapshots.length ? (
        <div className="fb-account-scroll">
          {snapshots.map((snapshot) => (
            <div key={snapshot.account.id} className="fb-account-pill">
              <div className="fb-account-pill-top">
                <strong>{snapshot.account.name}</strong>
                {snapshot.account.is_default ? <span className="fb-pill">Default</span> : null}
                {snapshot.account.is_two_percent_account ? <TwoPercentFundBadge /> : null}
              </div>
              <p className="fb-account-meta">
                {[snapshot.account.institution_name, snapshot.account.account_mask].filter(Boolean).join(" · ") ||
                  "Account"}
              </p>
              <p className="fb-account-balance">
                {snapshot.lastBalance != null ? formatUsd(snapshot.lastBalance) : "No balance recorded"}
              </p>
              <p className="fb-account-date">
                {snapshot.lastActivityDate ? `As of ${snapshot.lastActivityDate}` : "No activity yet"}
              </p>
              <button
                type="button"
                className="fb-secondary-btn"
                style={{ marginTop: 10, width: "100%" }}
                onClick={() => onViewAccountTransactions(snapshot.account.name)}
              >
                View transactions
              </button>
            </div>
          ))}
        </div>
      ) : (
        <section className="card">
          <p className="empty-state">
            No bank accounts configured yet. Add accounts under <strong>Settings</strong>.
          </p>
        </section>
      )}
      <BankAccountsSummary expenses={expenses} bankAccounts={bankAccounts} onBankAccountsChanged={onBankAccountsChanged} />
    </div>
  );
}

function NewExpensePage({
  membership,
  user,
  expenses,
  bankAccounts,
  launchTab,
  onLaunchConsumed,
  onExpensesChanged,
  setMessage,
  showSuccessMessage,
  showErrorMessage,
  showTwoPercentPanel,
  departmentCategories,
  departmentVendors,
}: {
  membership: DepartmentMembership;
  user: User;
  expenses: ExpenseRecord[];
  bankAccounts: BankAccount[];
  launchTab: ExpenseEntryLaunch;
  onLaunchConsumed: () => void;
  onExpensesChanged: () => Promise<void>;
  setMessage: (message: string | null) => void;
  showSuccessMessage: (message: string | null) => void;
  showErrorMessage: (message: string) => void;
  showTwoPercentPanel?: boolean;
  departmentCategories?: DepartmentCategory[];
  departmentVendors?: DepartmentVendor[];
}) {
  const [entryTab, setEntryTab] = useState<"receipt" | "manual">("receipt");
  const [draft, setDraft] = useState<ExpenseDraft | null>(null);
  const [reviewForm, setReviewForm] = useState<ReviewForm | null>(null);
  const [manualWorking, setManualWorking] = useState(false);
  const [working, setWorking] = useState(false);
  const [manualFormKey, setManualFormKey] = useState(0);
  const [isMobileDevice, setIsMobileDevice] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const coarse = window.matchMedia("(pointer: coarse)");
    const noHover = window.matchMedia("(hover: none)");
    function sync() {
      setIsMobileDevice(coarse.matches && noHover.matches);
    }
    sync();
    coarse.addEventListener("change", sync);
    noHover.addEventListener("change", sync);
    return () => {
      coarse.removeEventListener("change", sync);
      noHover.removeEventListener("change", sync);
    };
  }, []);

  useEffect(() => {
    if (!launchTab) return;
    setEntryTab(launchTab.tab);
    setDraft(null);
    setReviewForm(null);
    onLaunchConsumed();
  }, [launchTab, onLaunchConsumed]);

  function selectEntryTab(next: "receipt" | "manual") {
    if (next === entryTab) return;
    setEntryTab(next);
    setDraft(null);
    setReviewForm(null);
    setMessage(null);
  }

  const defaultBankAccount = bankAccounts.find((account) => account.is_default)?.name || "";

  function guessBankAccount(payee: string) {
    if (defaultBankAccount) return defaultBankAccount;
    const normalizedPayee = payee.trim().toLowerCase();
    if (!normalizedPayee) return "";
    const prior = expenses.find(
      (expense) =>
        (expense.payee || expense.merchant_name || "").trim().toLowerCase() === normalizedPayee &&
        expense.bank_account_name,
    );
    return prior?.bank_account_name || "";
  }

  async function prepareReviewFromFile(file: File) {
    setMessage(null);
    setWorking(true);

    const expenseId = crypto.randomUUID();
    const receiptId = crypto.randomUUID();
    const extracted = await extractReceipt(file);
    const receiptPath = buildReceiptPath({
      departmentId: membership.department_id,
      expenseId,
      receiptId,
      file,
    });
    const nextDraft: ExpenseDraft = {
      id: expenseId,
      receiptId,
      receiptFile: file,
      receiptPreviewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      receiptPath,
      createdAt: new Date().toISOString(),
      extracted,
      fund: "",
    };

    setDraft(nextDraft);
    const resolvedBankAccount = extracted.bank_account_name || guessBankAccount(extracted.payee || extracted.merchant_name || "");
    const resolvedAccount = bankAccounts.find((a) => a.name.toLowerCase() === resolvedBankAccount.toLowerCase());
    setReviewForm({
      fund: nextDraft.fund,
      payment_reference: extracted.payment_reference || "",
      payee: extracted.payee || extracted.merchant_name || "",
      description: extracted.description || "",
      bank_account_name: resolvedBankAccount,
      transaction_date: extracted.transaction_date || "",
      total_amount: extracted.total_amount || "",
      tax_amount: extracted.tax_amount || "",
      balance_after_transaction: extracted.balance_after_transaction || "",
      category: extracted.category || "",
      payment_method: matchPaymentMethod(extracted.payment_method || ""),
      uses_two_percent_funds: Boolean(resolvedAccount?.is_two_percent_account),
      member_vote_recorded: false,
      meeting_date: "",
      support_note: "",
    });
    setWorking(false);
  }

  async function confirmExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !reviewForm) return;
    setWorking(true);
    setMessage(null);
    try {
      const upload = await withTimeout(
        supabase.storage
          .from(receiptsBucket)
          .upload(draft.receiptPath, draft.receiptFile, {
            contentType: draft.receiptFile.type || "application/octet-stream",
            upsert: false,
          }),
        30000,
        "Uploading the receipt timed out. Check your connection and try again.",
      );
      if (upload.error) {
        if (!isResourceExistsError(upload.error.message)) {
          showErrorMessage(upload.error.message);
          return;
        }
      }

      const isTwoPct = Boolean(reviewForm.uses_two_percent_funds);
      const twoPctEvalRaw = isTwoPct
        ? evaluateTwoPercentStatus({
            vendor: reviewForm.payee,
            category: reviewForm.category,
            description: reviewForm.description,
          })
        : null;
      // Only persist potentially_not_allowed — "needs_review" is guidance noise, not a real flag.
      const twoPctEval = twoPctEvalRaw?.status === "needs_review" ? null : twoPctEvalRaw;

      const expensePayload: Record<string, unknown> = {
        id: draft.id,
        department_id: membership.department_id,
        receipt_id: draft.receiptId,
        receipt_path: draft.receiptPath,
        original_filename: draft.receiptFile.name || "receipt",
        content_type: draft.receiptFile.type || "application/octet-stream",
        created_at: draft.createdAt,
        created_by_user_id: user.id,
        created_by_email: user.email || "",
        uploaded_by: loggedByLabel(user),
        fund: optionalValue(reviewForm.fund),
        payment_reference: optionalValue(reviewForm.payment_reference),
        payee: optionalValue(reviewForm.payee),
        description: optionalValue(reviewForm.description),
        bank_account_name: optionalValue(reviewForm.bank_account_name),
        merchant_name: optionalValue(reviewForm.payee),
        transaction_date: optionalValue(reviewForm.transaction_date),
        total_amount: optionalNumber(reviewForm.total_amount),
        tax_amount: optionalNumber(reviewForm.tax_amount),
        balance_after_transaction: optionalNumber(reviewForm.balance_after_transaction),
        category: optionalValue(reviewForm.category),
        payment_method: optionalValue(reviewForm.payment_method),
        extraction_status: draft.extracted.extraction_status,
        extraction_confidence: draft.extracted.confidence,
        extraction_notes: draft.extracted.notes,
        reconciliation_status: "pending_bank_match",
        bank_match_confidence: 0,
        uses_two_percent_funds: isTwoPct,
        two_percent_review_status: twoPctEval?.status ?? null,
        two_percent_warning_reason: twoPctEval?.reason ?? null,
        member_vote_recorded: isTwoPct && reviewForm.member_vote_recorded ? true : null,
        meeting_date: isTwoPct ? optionalValue(reviewForm.meeting_date) : null,
        support_note: isTwoPct ? optionalValue(reviewForm.support_note) : null,
      };

      const insert = await withTimeout(
        insertExpenseWithSchemaFallback(expensePayload),
        30000,
        "Saving the expense timed out. Please try again.",
      );
      if (insert.error) {
        if (!isDuplicateExpenseError(insert.error.message)) {
          showErrorMessage(insert.error.message);
          return;
        }
      }

      setDraft(null);
      setReviewForm(null);
      showSuccessMessage("Expense logged. It is waiting for a bank transaction match.");
      void onExpensesChanged().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Expense saved, but refresh failed.";
        showErrorMessage(message);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save expense.";
      showErrorMessage(message);
    } finally {
      setWorking(false);
    }
  }

  async function submitManualExpense(values: ManualExpenseFormValues) {
    setManualWorking(true);
    const isTwoPct = values.uses_two_percent_funds;
    const twoPctEvalRaw = isTwoPct
      ? evaluateTwoPercentStatus({
          vendor: values.payee,
          category: values.category,
          description: values.description,
        })
      : null;
    // Only persist potentially_not_allowed — "needs_review" is guidance noise, not a real flag.
    const twoPctEval = twoPctEvalRaw?.status === "needs_review" ? null : twoPctEvalRaw;

    const payload: Record<string, unknown> = {
      id: crypto.randomUUID(),
      department_id: membership.department_id,
      receipt_id: crypto.randomUUID(),
      receipt_path: `${membership.department_id}/manual/${crypto.randomUUID()}/no-receipt`,
      original_filename: "manual-entry",
      content_type: "text/plain",
      created_at: new Date().toISOString(),
      created_by_user_id: user.id,
      created_by_email: user.email || "",
      uploaded_by: loggedByLabel(user),
      transaction_date: optionalValue(values.transaction_date),
      payee: optionalValue(values.payee),
      merchant_name: optionalValue(values.payee),
      total_amount: optionalNumber(values.total_amount),
      payment_method: optionalValue(values.payment_method),
      category: optionalValue(values.category),
      description: optionalValue(values.description),
      bank_account_name: optionalValue(values.bank_account_name),
      extraction_status: "needs_review",
      extraction_confidence: 0,
      extraction_notes: "Manual entry without receipt",
      reconciliation_status: "pending_bank_match",
      bank_match_confidence: 0,
      uses_two_percent_funds: isTwoPct,
      two_percent_review_status: twoPctEval?.status ?? null,
      two_percent_warning_reason: twoPctEval?.reason ?? null,
      member_vote_recorded: isTwoPct && values.member_vote_recorded ? true : null,
      meeting_date: isTwoPct ? optionalValue(values.meeting_date) : null,
      support_note: isTwoPct ? optionalValue(values.support_note) : null,
    };
    const result = await supabase.from("expenses").insert(payload);
    if (result.error) {
      showErrorMessage(result.error.message);
      setManualWorking(false);
      return;
    }
    showSuccessMessage("Manual expense logged.");
    setManualFormKey((k) => k + 1);
    await onExpensesChanged();
    setManualWorking(false);
  }

  return (
    <div className="fb-tab-stack fb-new-expense-page">
      <DepartmentSetupBanner membership={membership} user={user} bankAccounts={bankAccounts} />

      <section className="card fb-new-expense-hero">
        <p className="eyebrow">Entry</p>
        <h1 className="fb-dash-title">New Expense</h1>
        <p className="fb-dash-subtitle">Upload a receipt or manually enter an expense.</p>
        <div className="fb-segmented" role="tablist" aria-label="Expense entry type">
          <button
            type="button"
            role="tab"
            aria-selected={entryTab === "receipt"}
            className={`fb-segment ${entryTab === "receipt" ? "fb-segment--active" : ""}`}
            onClick={() => selectEntryTab("receipt")}
          >
            Log with Receipt
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={entryTab === "manual"}
            className={`fb-segment ${entryTab === "manual" ? "fb-segment--active" : ""}`}
            onClick={() => selectEntryTab("manual")}
          >
            Manual Entry
          </button>
        </div>
      </section>

      <section className="card upload-card fb-expense-card">
        {draft && reviewForm ? (
          <ReviewExpenseForm
            draft={draft}
            form={reviewForm}
            expenses={expenses}
            bankAccounts={bankAccounts}
            loggedBy={loggedByLabel(user)}
            setForm={setReviewForm}
            disabled={working}
            onSubmit={confirmExpense}
            onCancel={() => {
              setDraft(null);
              setReviewForm(null);
            }}
            showTwoPercentPanel={showTwoPercentPanel}
            departmentCategories={departmentCategories}
            departmentVendors={departmentVendors}
          />
        ) : entryTab === "receipt" ? (
          <>
            <div className="section-heading">
              <p className="eyebrow">Receipt</p>
              <h2>Add a receipt</h2>
            </div>
            <div className="fb-receipt-upload-wrap">
              <ReceiptUploadAction
                isMobileDevice={isMobileDevice}
                disabled={working}
                onFileSelected={prepareReviewFromFile}
              />
            </div>
            <div className="integration-note">
              Receipt fields are autofilled when extraction succeeds. You confirm the register fields before the expense is
              logged.
            </div>
          </>
        ) : (
          <>
            <div className="section-heading">
              <p className="eyebrow">Manual</p>
              <h2>Enter expense details</h2>
            </div>
            <ManualExpenseForm
              key={manualFormKey}
              expenses={expenses}
              bankAccounts={bankAccounts}
              defaultBankAccount={defaultBankAccount}
              disabled={manualWorking}
              onSubmit={submitManualExpense}
              showTwoPercentPanel={showTwoPercentPanel}
              departmentCategories={departmentCategories}
              departmentVendors={departmentVendors}
            />
          </>
        )}
      </section>
    </div>
  );
}

function ReportsDocumentsSection({
  mode,
  setMode,
  membership,
  user,
  departmentName,
  expenses,
  receiptUrls,
  bankAccounts,
  departmentSettings,
  statementUrls,
  onExpensesChanged,
  onStatementUrlsChanged,
  showErrorMessage,
  showSuccessMessage,
}: {
  mode: ReportsDocumentsMode;
  setMode: (next: ReportsDocumentsMode) => void;
  membership: DepartmentMembership;
  user: User;
  departmentName: string;
  expenses: ExpenseRecord[];
  receiptUrls: Record<string, string>;
  bankAccounts: BankAccount[];
  departmentSettings: DepartmentSetting | null;
  statementUrls: Record<string, string>;
  onExpensesChanged: () => Promise<void>;
  onStatementUrlsChanged: (uploads: BankStatementUpload[]) => Promise<void>;
  showErrorMessage: (message: string) => void;
  showSuccessMessage: (message: string | null) => void;
}) {
  if (mode === "reconciliation") {
    return (
      <div className="fb-tab-stack">
        <button type="button" className="fb-back-link link-button" onClick={() => setMode("hub")}>
          ← Back to reports & documents
        </button>
        <Reports
          membership={membership}
          user={user}
          departmentName={departmentName}
          expenses={expenses}
          receiptUrls={receiptUrls}
          bankAccounts={bankAccounts}
          onExpensesChanged={onExpensesChanged}
          onStatementUrlsChanged={onStatementUrlsChanged}
          statementUrls={statementUrls}
          showErrorMessage={showErrorMessage}
          showSuccessMessage={showSuccessMessage}
        />
      </div>
    );
  }
  if (mode === "statements") {
    return (
      <div className="fb-tab-stack">
        <button type="button" className="fb-back-link link-button" onClick={() => setMode("hub")}>
          ← Back to reports & documents
        </button>
        <Statements
          membership={membership}
          user={user}
          bankAccounts={bankAccounts}
          departmentSettings={departmentSettings}
          onExpensesChanged={onExpensesChanged}
          onStatementUrlsChanged={onStatementUrlsChanged}
          statementUrls={statementUrls}
          showErrorMessage={showErrorMessage}
          showSuccessMessage={showSuccessMessage}
        />
      </div>
    );
  }

  if (mode === "two_percent_activity") {
    return (
      <div className="fb-tab-stack">
        <button type="button" className="fb-back-link link-button" onClick={() => setMode("hub")}>
          ← Back to reports & documents
        </button>
        <TwoPercentActivityReport expenses={expenses} bankAccounts={bankAccounts} />
      </div>
    );
  }

  const placeholders = [
    { title: "Expense report", desc: "Roll-up of expenses by period (coming soon)." },
    { title: "Vendor report", desc: "Spend concentration by vendor (coming soon)." },
    { title: "Category report", desc: "Budget lines vs actuals (coming soon)." },
    { title: "Year-end report", desc: "Annual close package (coming soon)." },
  ];

  const hasTwoPctAccounts = bankAccounts.some((a) => a.is_two_percent_account);

  return (
    <div className="fb-tab-stack">
      <section className="card fb-dash-welcome">
        <p className="eyebrow">Library</p>
        <h1 className="fb-dash-title">Reports &amp; Documents</h1>
        <p className="fb-dash-subtitle">Run reconciliation work and browse other reports as they become available.</p>
      </section>
      <div className="fb-doc-hub-grid">
        <div className="fb-doc-hub-card fb-doc-hub-card--primary">
          <h2>Reconciliation report</h2>
          <p className="muted">Existing reconciliation workflow, CSV export, and statement tie-ins.</p>
          <button type="button" className="fb-primary-btn" onClick={() => setMode("reconciliation")}>
            Open reconciliation report
          </button>
        </div>
        <div className="fb-doc-hub-card fb-doc-hub-card--primary">
          <h2>Bank statements</h2>
          <p className="muted">Upload pages, extract transactions, and reconcile against the ledger.</p>
          <button type="button" className="fb-primary-btn" onClick={() => setMode("statements")}>
            Open statements
          </button>
        </div>
        {hasTwoPctAccounts && (
          <div className="fb-doc-hub-card fb-doc-hub-card--primary">
            <div className="nys-card-badge" style={{ background: "var(--fb-navy)", color: "#fff" }}>
              2% Funds
            </div>
            <h2>2% Funds Activity Report</h2>
            <p className="muted">
              Review income, expenditures, and flagged transactions from your Foreign Fire Insurance Fund account.
              Export a supporting report alongside the NYS annual filing.
            </p>
            <button type="button" className="fb-primary-btn" onClick={() => setMode("two_percent_activity")}>
              Open activity report
            </button>
          </div>
        )}
        {placeholders.map((p) => (
          <div key={p.title} className="fb-doc-hub-card">
            <h2>{p.title}</h2>
            <p className="muted">{p.desc}</p>
            <button type="button" className="fb-secondary-btn" disabled>
              Generate (soon)
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function TwoPercentActivityReport({
  expenses,
  bankAccounts,
}: {
  expenses: ExpenseRecord[];
  bankAccounts: BankAccount[];
}) {
  const currentYear = new Date().getFullYear();
  const [reportYear, setReportYear] = useState(String(currentYear));
  const yearInt = Number(reportYear) || currentYear;

  const twoPercentAccounts = useMemo(
    () => bankAccounts.filter((a) => a.is_two_percent_account),
    [bankAccounts],
  );

  const twoPercentExpenses = useMemo(() => {
    const names = new Set(twoPercentAccounts.map((a) => a.name.toLowerCase()));
    return expenses.filter((e) => {
      const inYear =
        (e.transaction_date?.slice(0, 4) || e.created_at?.slice(0, 4)) === String(yearInt);
      const isTwoPct =
        e.uses_two_percent_funds ||
        (e.bank_account_name && names.has(e.bank_account_name.toLowerCase()));
      return inYear && isTwoPct;
    });
  }, [expenses, twoPercentAccounts, yearInt]);

  const byCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of twoPercentExpenses) {
      const cat = e.category || "Uncategorized";
      const amt =
        typeof e.total_amount === "number"
          ? e.total_amount
          : Number(String(e.total_amount || "0").replace(/[$,]/g, "")) || 0;
      if (amt > 0) map.set(cat, (map.get(cat) ?? 0) + amt);
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([category, total]) => ({ category, total }));
  }, [twoPercentExpenses]);

  const totalExpenses = byCategory.reduce((sum, row) => sum + row.total, 0);

  const flaggedExpenses = useMemo(
    () =>
      twoPercentExpenses.filter(
        (e) => e.two_percent_review_status === "potentially_not_allowed",
      ),
    [twoPercentExpenses],
  );

  const unsupportedCount = useMemo(
    () =>
      twoPercentExpenses.filter(
        (e) =>
          !e.receipt_path ||
          e.receipt_path.includes("no-receipt") ||
          e.receipt_path.includes("/manual/"),
      ).length,
    [twoPercentExpenses],
  );

  return (
    <div className="fb-tab-stack">
      <section className="card fb-dash-welcome">
        <p className="eyebrow">2% Funds</p>
        <h1 className="fb-dash-title">2% Funds Activity Report</h1>
        <p className="fb-dash-subtitle">
          Review Foreign Fire Insurance Fund income, expenditures by category, and flagged transactions.
          Use this as a supporting document alongside the official NYS annual filing.
        </p>
      </section>

      <section className="card">
        <div className="fb-2pct-report-controls" style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="muted">Report year</span>
            <select
              value={reportYear}
              onChange={(e) => setReportYear(e.target.value)}
              className="fb-input-sm"
            >
              {[currentYear, currentYear - 1, currentYear - 2].map((y) => (
                <option key={y} value={String(y)}>{y}</option>
              ))}
            </select>
          </label>
          <span className="muted" style={{ fontSize: 13 }}>
            Accounts: {twoPercentAccounts.length > 0 ? twoPercentAccounts.map((a) => a.name).join(", ") : "None tagged"}
          </span>
        </div>

        {unsupportedCount > 0 && (
          <div className="notice notice-warn" style={{ marginBottom: 12 }}>
            <strong>{unsupportedCount} transaction{unsupportedCount > 1 ? "s" : ""}</strong> missing a receipt. Review before filing.
          </div>
        )}
        {flaggedExpenses.length > 0 && (
          <div className="notice notice-warn" style={{ marginBottom: 12 }}>
            <strong>{flaggedExpenses.length} transaction{flaggedExpenses.length > 1 ? "s" : ""}</strong> flagged Needs Review or Potentially Not Allowed. Confirm before finalizing.
          </div>
        )}

        <div className="fb-metric-grid" style={{ marginBottom: 20 }}>
          <div className="fb-metric-card">
            <p className="fb-metric-label">Total 2% expenditures {yearInt}</p>
            <p className="fb-metric-value fb-metric-value--out">{formatUsd(totalExpenses)}</p>
          </div>
          <div className="fb-metric-card">
            <p className="fb-metric-label">Transactions</p>
            <p className="fb-metric-value">{twoPercentExpenses.length}</p>
          </div>
          <div className="fb-metric-card">
            <p className="fb-metric-label">Flagged for review</p>
            <p className={`fb-metric-value ${flaggedExpenses.length > 0 ? "fb-metric-value--warn" : ""}`}>
              {flaggedExpenses.length}
            </p>
          </div>
        </div>

        {byCategory.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Category / Purpose</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {byCategory.map((row) => (
                  <tr key={row.category}>
                    <td>{row.category}</td>
                    <td>{formatUsd(row.total)}</td>
                  </tr>
                ))}
                <tr style={{ fontWeight: 600 }}>
                  <td>Total</td>
                  <td>{formatUsd(totalExpenses)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-state">No 2% fund transactions found for {yearInt}.</p>
        )}

        {twoPercentExpenses.length > 0 && (
          <details style={{ marginTop: 16 }}>
            <summary style={{ cursor: "pointer", color: "var(--fb-navy)", fontWeight: 500 }}>
              View all {twoPercentExpenses.length} transactions
            </summary>
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Payee</th>
                    <th>Category</th>
                    <th>Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {twoPercentExpenses.map((e) => {
                    const amt =
                      typeof e.total_amount === "number"
                        ? e.total_amount
                        : Number(String(e.total_amount || "0").replace(/[$,]/g, "")) || 0;
                    return (
                      <tr key={e.id}>
                        <td>{e.transaction_date || "—"}</td>
                        <td>{e.payee || e.merchant_name || "—"}</td>
                        <td>{e.category || "—"}</td>
                        <td>{amt > 0 ? formatUsd(amt) : "—"}</td>
                        <td>
                          {e.two_percent_review_status ? (
                            <TwoPercentStatusBadge status={e.two_percent_review_status} />
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        )}

        <p className="muted" style={{ marginTop: 16, fontSize: 12 }}>{TWO_PERCENT_DISCLAIMER}</p>
      </section>
    </div>
  );
}

function Dashboard({
  membership,
  user,
  expenses,
  bankAccounts,
  onNavigateView,
  onOpenReportsPanel,
  onOpenNewExpense,
}: {
  membership: DepartmentMembership;
  user: User;
  expenses: ExpenseRecord[];
  bankAccounts: BankAccount[];
  onNavigateView: (next: AppView) => void;
  onOpenReportsPanel: (panel: "reconciliation" | "statements") => void;
  onOpenNewExpense: (tab: "receipt" | "manual") => void;
}) {
  const welcomeName = membership.role?.trim() || "member";
  const metrics = useMemo(() => buildDashboardMetrics(expenses), [expenses]);
  const twoPercentSnapshot = useMemo(
    () => buildTwoPercentSnapshot(expenses, bankAccounts),
    [expenses, bankAccounts],
  );

  return (
    <>
      <DepartmentSetupBanner membership={membership} user={user} bankAccounts={bankAccounts} />

      <section className="card fb-dash-welcome">
        <h1 className="fb-dash-title">Welcome back, {welcomeName}</h1>
        <p className="fb-dash-subtitle">Here&apos;s what&apos;s happening with your department finances today.</p>
      </section>

      <div className="fb-metric-grid">
        <div className="fb-metric-card">
          <p className="fb-metric-label">Total recorded</p>
          <p className="fb-metric-value">{formatUsd(metrics.totalRecorded)}</p>
          <p className="fb-metric-hint">Sum of logged expense amounts</p>
        </div>
        <div className="fb-metric-card">
          <p className="fb-metric-label">This month (expenses)</p>
          <p className="fb-metric-value fb-metric-value--out">{formatUsd(metrics.monthSpend)}</p>
          <p className="fb-metric-hint">Based on transaction dates in the current month</p>
        </div>
        <div className="fb-metric-card">
          <p className="fb-metric-label">This month (bank)</p>
          <p className="fb-metric-split">
            <span className="fb-metric-in">In {formatUsd(metrics.monthBankIn)}</span>
            <span className="fb-metric-out">Out {formatUsd(metrics.monthBankOut)}</span>
          </p>
          <p className="fb-metric-hint">From imported bank amounts on matched activity</p>
        </div>
        <div className="fb-metric-card">
          <p className="fb-metric-label">Needs attention</p>
          <p className="fb-metric-value">
            {metrics.needsReview} review · {metrics.openItems} open
          </p>
          <p className="fb-metric-hint">Extraction issues plus unreconciled items</p>
        </div>
      </div>

      <section className="card fb-quick-actions">
        <div className="fb-section-head">
          <div>
            <p className="eyebrow">Shortcuts</p>
            <h2>Quick actions</h2>
          </div>
        </div>
        <div className="fb-quick-grid">
          <button type="button" className="fb-quick-tile" onClick={() => onOpenNewExpense("receipt")}>
            <span className="fb-quick-title">Log with receipt</span>
            <span className="fb-quick-desc">Capture or upload a receipt to extract details.</span>
          </button>
          <button type="button" className="fb-quick-tile" onClick={() => onOpenNewExpense("manual")}>
            <span className="fb-quick-title">Manual expense</span>
            <span className="fb-quick-desc">Record a purchase without a receipt file.</span>
          </button>
          <button type="button" className="fb-quick-tile" onClick={() => onOpenReportsPanel("reconciliation")}>
            <span className="fb-quick-title">Reconciliation report</span>
            <span className="fb-quick-desc">Review matches and export a CSV report.</span>
          </button>
          <button type="button" className="fb-quick-tile" onClick={() => onOpenReportsPanel("statements")}>
            <span className="fb-quick-title">Statements</span>
            <span className="fb-quick-desc">Upload statement pages for reconciliation.</span>
          </button>
          <button type="button" className="fb-quick-tile" onClick={() => onNavigateView("settings")}>
            <span className="fb-quick-title">Settings</span>
            <span className="fb-quick-desc">Bank accounts, Plaid, and department preferences.</span>
          </button>
        </div>
      </section>

      {twoPercentSnapshot ? (
        <section className="card fb-2pct-snapshot">
          <div className="fb-section-head">
            <div>
              <p className="eyebrow">NYS Foreign Fire Insurance</p>
              <h2>
                2% Funds
                <TwoPercentFundBadge className="fb-2pct-snapshot-badge" />
              </h2>
            </div>
            <button
              type="button"
              className="link-button"
              onClick={() => onNavigateView("tax_forms")}
            >
              Annual report →
            </button>
          </div>
          <div className="fb-metric-grid fb-2pct-metric-grid">
            <div className="fb-metric-card">
              <p className="fb-metric-label">Account balance</p>
              <p className="fb-metric-value">
                {twoPercentSnapshot.latestBalance != null
                  ? formatUsd(twoPercentSnapshot.latestBalance)
                  : "—"}
              </p>
              <p className="fb-metric-hint">
                {twoPercentSnapshot.accounts[0]?.name ?? "2% account"} · latest recorded
              </p>
            </div>
            <div className="fb-metric-card">
              <p className="fb-metric-label">2% expenses {twoPercentSnapshot.reportYear}</p>
              <p className="fb-metric-value fb-metric-value--out">
                {formatUsd(twoPercentSnapshot.yearExpenses)}
              </p>
              <p className="fb-metric-hint">From tagged 2% fund transactions this year</p>
            </div>
            <div className="fb-metric-card">
              <p className="fb-metric-label">Annual report</p>
              <p className="fb-metric-value">{twoPercentSnapshot.reportYear}</p>
              <p className="fb-metric-hint">
                <button
                  type="button"
                  className="link-button"
                  onClick={() => onNavigateView("tax_forms")}
                >
                  Prepare in Tax Forms →
                </button>
              </p>
            </div>
          </div>
        </section>
      ) : null}

      <section className="card fb-search-hint">
        <div className="fb-section-head">
          <div>
            <p className="eyebrow">Search</p>
            <h2>Find transactions</h2>
          </div>
        </div>
        <p className="muted">
          Use <strong>New Expense</strong> in the header to log receipts or manual entries. Use the search field to filter
          vendors and memos, then press <strong>Search</strong> to open the <strong>Transactions</strong> tab with the full
          ledger, quarterly sections, and filters.
        </p>
      </section>
    </>
  );
}

function ReceiptUploadAction({
  isMobileDevice,
  disabled,
  onFileSelected,
}: {
  isMobileDevice: boolean;
  disabled: boolean;
  onFileSelected: (file: File) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const title = isMobileDevice ? "Add Receipt" : "Upload Receipt";
  const description = isMobileDevice
    ? "Take a photo or upload from your device."
    : "Upload a receipt image or PDF.";

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    await onFileSelected(file);
    event.target.value = "";
  }

  return (
    <div className="capture-option fb-receipt-upload-single">
      <div>
        <strong>{title}</strong>
        <p className="muted">{description}</p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf"
        onChange={handleFileChange}
        style={{ display: "none" }}
      />
      <button type="button" className="fb-receipt-opt-btn" disabled={disabled} onClick={() => inputRef.current?.click()}>
        {disabled ? "Extracting..." : title}
      </button>
    </div>
  );
}

function ReviewExpenseForm({
  draft,
  form,
  expenses,
  bankAccounts,
  loggedBy,
  setForm,
  disabled,
  onSubmit,
  onCancel,
  showTwoPercentPanel,
  departmentCategories,
  departmentVendors,
}: {
  draft: ExpenseDraft;
  form: ReviewForm;
  expenses: ExpenseRecord[];
  bankAccounts: BankAccount[];
  loggedBy: string;
  setForm: (form: ReviewForm) => void;
  disabled: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onCancel: () => void;
  showTwoPercentPanel?: boolean;
  departmentCategories?: DepartmentCategory[];
  departmentVendors?: DepartmentVendor[];
}) {
  const [showMoreDetails, setShowMoreDetails] = useState(false);

  function update(field: keyof ReviewForm, value: string | boolean) {
    setForm({ ...form, [field]: value });
  }

  function handleBankAccountChange(newAcct: string) {
    const acct = bankAccounts.find((a) => a.name.toLowerCase() === newAcct.toLowerCase());
    setForm({ ...form, bank_account_name: newAcct, uses_two_percent_funds: Boolean(acct?.is_two_percent_account) || form.uses_two_percent_funds });
  }

  function handleTwoPctToggle(checked: boolean) {
    if (checked) {
      const twoPctAcct = bankAccounts.find((a) => a.is_two_percent_account);
      const newAcct = twoPctAcct && form.bank_account_name.toLowerCase() !== twoPctAcct.name.toLowerCase() ? twoPctAcct.name : form.bank_account_name;
      const newCategory = !form.category ? (suggestTwoPctCategory(form.payee) ?? suggestCategoryForVendor(form.payee, expenses, departmentVendors) ?? form.category) : form.category;
      setForm({ ...form, uses_two_percent_funds: true, bank_account_name: newAcct, category: newCategory });
    } else {
      update("uses_two_percent_funds", false);
    }
  }

  function handleVendorChange(vendor: string) {
    const historySuggestion = suggestCategoryForVendor(vendor, expenses, departmentVendors);
    if (historySuggestion) {
      update("category", historySuggestion);
    } else if (form.uses_two_percent_funds) {
      const twoPctSuggestion = suggestTwoPctCategory(vendor);
      if (twoPctSuggestion) update("category", twoPctSuggestion);
    }
  }

  const isTwoPct = Boolean(form.uses_two_percent_funds);

  return (
    <>
      <div className="section-heading">
        <p className="eyebrow">Confirm expense details</p>
        <h2>Review before logging</h2>
      </div>
      {draft.receiptPreviewUrl && (
        <img className="receipt-preview" src={draft.receiptPreviewUrl} alt="Receipt preview" />
      )}
      {draft.extracted.notes && <div className="integration-note">{draft.extracted.notes}</div>}
      <form onSubmit={onSubmit} className="upload-form fb-expense-form">
        {/* Core fields — always visible */}
        <div className="form-grid two-column">
          <TextField label="Date" type="date" value={form.transaction_date} onChange={(v) => update("transaction_date", v)} required />
          <VendorAutocompleteField
            label="Paid to / vendor"
            value={form.payee}
            onChange={(v) => update("payee", v)}
            expenses={expenses}
            departmentVendors={departmentVendors}
            required
            onVendorChange={handleVendorChange}
          />
          <CentsMoneyInput label="Payment amount" value={form.total_amount} onChange={(v) => update("total_amount", v)} required />
          <BankAccountSelect
            label="Bank account"
            value={form.bank_account_name}
            onChange={handleBankAccountChange}
            bankAccounts={bankAccounts}
          />
          <CategoryComboboxField
            label="Category / purpose"
            value={form.category}
            onChange={(v) => update("category", v)}
            expenses={expenses}
            departmentCategories={departmentCategories}
            twoPctMode={isTwoPct}
          />
        </div>
        <div className="fb-2pct-tag-row">
          <label className="fb-2pct-tag-label">
            <input type="checkbox" checked={isTwoPct} onChange={(e) => handleTwoPctToggle(e.target.checked)} />
            <span>Tag as 2% Funds expense</span>
            {isTwoPct && <TwoPercentFundBadge className="fb-2pct-tag-badge" />}
          </label>
        </div>
        <label>
          Description / memo
          <textarea
            rows={3}
            value={form.description}
            onChange={(event) => update("description", event.target.value)}
          />
        </label>

        {/* More details toggle */}
        <button
          type="button"
          className="fb-more-details-toggle link-button"
          onClick={() => setShowMoreDetails((v) => !v)}
        >
          {showMoreDetails ? "▲ Fewer details" : "▼ More details"}
        </button>

        {showMoreDetails && (
          <div className="fb-more-details form-grid two-column">
            <TextField label="Check / payment ref" value={form.payment_reference} onChange={(v) => update("payment_reference", v)} placeholder="Check #, debit, ACH, card..." />
            <PaymentMethodSelect label="Payment method" value={form.payment_method} onChange={(v) => update("payment_method", v)} />
            <CentsMoneyInput label="Tax" value={form.tax_amount} onChange={(v) => update("tax_amount", v)} />
            <TextField label="Balance after transaction" value={form.balance_after_transaction} onChange={(v) => update("balance_after_transaction", v)} />
            <TextField label="Fund / budget line" value={form.fund} onChange={(v) => update("fund", v)} placeholder="General, equipment, fuel..." />
            {isTwoPct && showTwoPercentPanel && (
              <div className="form-grid-full">
                <TwoPercentGuidancePanel
                  vendor={form.payee}
                  category={form.category}
                  description={form.description}
                  memberVoteRecorded={form.member_vote_recorded}
                  meetingDate={form.meeting_date}
                  supportNote={form.support_note}
                  onMemberVoteChange={(v) => update("member_vote_recorded", v)}
                  onMeetingDateChange={(v) => update("meeting_date", v)}
                  onSupportNoteChange={(v) => update("support_note", v)}
                />
              </div>
            )}
          </div>
        )}

        <div className="integration-note">Logged by: {loggedBy}</div>
        <div className="button-row">
          <button type="submit" disabled={disabled}>
            {disabled ? "Saving..." : "Confirm and log expense"}
          </button>
          <button type="button" className="secondary-action" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
  required,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <label>
      {label}
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        placeholder={placeholder}
      />
    </label>
  );
}

function BankAccountsSummary({
  expenses,
  bankAccounts,
  onBankAccountsChanged,
}: {
  expenses: ExpenseRecord[];
  bankAccounts: BankAccount[];
  onBankAccountsChanged: () => Promise<void>;
}) {
  return (
    <section className="card fb-bank-summary">
      <div className="section-heading">
        <p className="eyebrow">Bank accounts</p>
        <h2>Accounts and recent transactions</h2>
      </div>
      {bankAccounts.length ? (
        <div className="summary-grid">
          {bankAccounts.map((account) => {
            const recent = expenses
              .filter((expense) => expense.bank_account_name?.toLowerCase() === account.name.toLowerCase())
              .slice(0, 3);
            return (
              <div key={account.id}>
                <span className="summary-label">
                  {account.name}
                  {account.is_default ? " (default)" : ""}
                </span>
                {recent.length ? (
                  recent.map((expense) => (
                    <span key={expense.id} className="filename">
                      {expense.transaction_date || "No date"} - {expense.payee || expense.merchant_name || "Expense"} - $
                      {expense.total_amount || "0"}
                    </span>
                  ))
                ) : (
                  <span className="filename">No recent transactions</span>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="empty-state">
          No bank accounts configured yet. Add one in Settings.
          <button type="button" className="link-button" onClick={() => void onBankAccountsChanged()}>
            Refresh
          </button>
        </p>
      )}
    </section>
  );
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
      <div className="reconciliation-progress__track" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="reconciliation-progress__fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function Reports({
  membership,
  user,
  departmentName,
  expenses,
  receiptUrls,
  bankAccounts,
  onExpensesChanged,
  onStatementUrlsChanged,
  statementUrls,
  showErrorMessage,
  showSuccessMessage,
}: {
  membership: DepartmentMembership;
  user: User;
  departmentName: string;
  expenses: ExpenseRecord[];
  receiptUrls: Record<string, string>;
  bankAccounts: BankAccount[];
  onExpensesChanged: () => Promise<void>;
  onStatementUrlsChanged: (uploads: BankStatementUpload[]) => Promise<void>;
  statementUrls: Record<string, string>;
  showErrorMessage: (message: string) => void;
  showSuccessMessage: (message: string | null) => void;
}) {
  const [startDate, setStartDate] = useState(defaultReportStart);
  const [endDate, setEndDate] = useState(defaultReportEnd);
  const [bankAccountName, setBankAccountName] = useState("");
  const [reconWorking, setReconWorking] = useState(false);
  const [uploads, setUploads] = useState<BankStatementUpload[]>([]);

  useEffect(() => {
    void loadStatementUploads();
  }, [membership.department_id]);
  const report = useMemo(
    () =>
      buildReconciliationReport({
        expenses,
        departmentName,
        startDate,
        endDate,
        bankAccountName,
      }),
    [bankAccountName, departmentName, endDate, expenses, startDate],
  );

  function downloadCsv() {
    const blob = new Blob([reconciliationReportCsv(report, receiptUrls)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `reconciliation-${startDate}-${endDate}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function handleStatementUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setReconWorking(true);
    try {
      const form = new FormData();
      form.append("statement", file);
      const response = await fetch("/api/extract-bank-statement", { method: "POST", body: form });
      const extraction = (await response.json()) as BankStatementExtraction;
      const statementPath = buildStatementPath({
        departmentId: membership.department_id,
        file,
      });
      const upload = await supabase.storage.from(bankStatementsBucket).upload(statementPath, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
      if (upload.error) {
        throw new Error(upload.error.message);
      }
      await applyStatementReconciliation({
        membership,
        user,
        extraction,
        selectedBankAccountName: bankAccountName,
        statementFiles: [
          {
            path: statementPath,
            originalFilename: file.name || "statement",
            contentType: file.type || "application/octet-stream",
          },
        ],
        autoLogUnmatched: false,
      });
      await onExpensesChanged();
      await loadStatementUploads();
      showSuccessMessage("Statement imported. Matching transactions were reconciled.");
    } catch (error) {
      showErrorMessage(error instanceof Error ? error.message : "Could not process statement upload.");
    } finally {
      setReconWorking(false);
      event.target.value = "";
    }
  }

  async function loadStatementUploads() {
    const { data, error } = await supabase
      .from("bank_statement_uploads")
      .select("*")
      .eq("department_id", membership.department_id)
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) return;
    const rows = (data || []) as BankStatementUpload[];
    setUploads(rows);
    await onStatementUrlsChanged(rows);
  }

  return (
    <section className="card report-card report-wide">
      <div className="section-heading">
        <p className="eyebrow">Bank reconciliation</p>
        <h2>Reconciliation report</h2>
      </div>
      <div className="report-controls">
        <TextField label="Start date" type="date" value={startDate} onChange={setStartDate} />
        <TextField label="Period ending" type="date" value={endDate} onChange={setEndDate} />
        <label>
          Bank account
          <select value={bankAccountName} onChange={(event) => setBankAccountName(event.target.value)}>
            <option value="">All accounts</option>
            {bankAccounts.map((account) => (
              <option key={account.id} value={account.name}>
                {account.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Manual statement reconcile
          <input type="file" accept="image/*,application/pdf" onChange={handleStatementUpload} disabled={reconWorking} />
        </label>
        <button type="button" onClick={downloadCsv}>
          Download CSV
        </button>
      </div>
      <div className="summary-grid">
        <div>
          <span className="summary-label">Cleared transactions</span>
          <strong>{report.clearedRows.length}</strong>
          <span>${report.clearedTotal.toFixed(2)}</span>
        </div>
        <div>
          <span className="summary-label">New / unmatched</span>
          <strong>{report.newRows.length}</strong>
          <span>${report.newTotal.toFixed(2)}</span>
        </div>
        <div>
          <span className="summary-label">Register balance</span>
          <strong>
            {report.endingRegisterBalance == null ? "Not entered" : `$${report.endingRegisterBalance}`}
          </strong>
          <span>Latest balance in period</span>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Section</th>
              <th>Type</th>
              <th>Date</th>
              <th>Num</th>
              <th>Name</th>
              <th>Reconciled on report</th>
              <th>Amount</th>
              <th>Balance</th>
              <th>Bank</th>
              <th>Receipt</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <tr key={row.expense.id}>
                <td>{row.section}</td>
                <td>{row.expense.payment_method || "Expense"}</td>
                <td>{row.expense.transaction_date || ""}</td>
                <td>{row.expense.payment_reference || ""}</td>
                <td>{row.expense.payee || row.expense.merchant_name || "Needs review"}</td>
                <td>
                  <span className={`status ${row.reconciledOnReport ? "status-matched" : "status-pending_bank_match"}`}>
                    {row.reconciledOnReport ? "Yes" : "No"}
                  </span>
                </td>
                <td>{row.expense.total_amount ? `$${row.expense.total_amount}` : ""}</td>
                <td>
                  {row.expense.balance_after_transaction
                    ? `$${row.expense.balance_after_transaction}`
                    : ""}
                </td>
                <td>{row.expense.bank_account_name || ""}</td>
                <td>
                  {receiptUrls[row.expense.id] ? (
                    <a href={receiptUrls[row.expense.id]} target="_blank" rel="noopener noreferrer">
                      Receipt
                    </a>
                  ) : (
                    ""
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-wrap">
        <h3>Uploaded bank statements</h3>
        <table>
          <thead>
            <tr>
              <th>Date uploaded</th>
              <th>Account</th>
              <th>Period</th>
              <th>Beginning</th>
              <th>Ending</th>
              <th>File</th>
            </tr>
          </thead>
          <tbody>
            {uploads.map((upload) => (
              <tr key={upload.id}>
                <td>{upload.created_at}</td>
                <td>{upload.bank_account_name || ""}</td>
                <td>
                  {upload.statement_start_date || ""} - {upload.statement_end_date || ""}
                </td>
                <td>{upload.beginning_balance ?? ""}</td>
                <td>{upload.ending_balance ?? ""}</td>
                <td>
                  {statementUrls[upload.id] ? (
                    <a href={statementUrls[upload.id]} target="_blank" rel="noopener noreferrer">
                      View statement
                    </a>
                  ) : (
                    upload.original_filename || ""
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type SettingsSectionId =
  | "overview"
  | "onboarding"
  | "bank_accounts"
  | "members"
  | "categories"
  | "permissions"
  | "compliance"
  | "notifications"
  | "security";

const SETTINGS_NAV: { id: SettingsSectionId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "onboarding", label: "Onboarding" },
  { id: "bank_accounts", label: "Bank Accounts" },
  { id: "members", label: "Department Members" },
  { id: "categories", label: "Categories" },
  { id: "permissions", label: "Permissions & Approvals" },
  { id: "compliance", label: "Compliance" },
  { id: "notifications", label: "Notifications" },
  { id: "security", label: "Security" },
];

type ExternalPlaidAccount = {
  id: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
  created_at: string;
};

type DepartmentMemberRow = {
  user_id: string;
  role: string;
  created_at: string;
};

type DisplayBankRow =
  | { source: "bank"; bank: BankAccount; plaid: ExternalPlaidAccount | null }
  | { source: "plaid"; plaid: ExternalPlaidAccount; bank: null };

function formatSettingsDate(iso: string | null | undefined) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "—";
  }
}

function matchPlaidAccount(account: BankAccount, externalAccounts: ExternalPlaidAccount[]) {
  const mask = account.account_mask?.trim();
  const name = account.name.trim().toLowerCase();
  return (
    externalAccounts.find((ext) => {
      if (mask && ext.mask && ext.mask.replace(/\D/g, "") === mask.replace(/\D/g, "")) return true;
      const extName = ext.name.trim().toLowerCase();
      return extName === name || extName.includes(name) || name.includes(extName);
    }) ?? null
  );
}

function uniqueCategoriesFromExpenses(expenses: ExpenseRecord[]) {
  const set = new Set<string>();
  for (const expense of expenses) {
    const category = (expense.category || "").trim();
    if (category) set.add(category);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function latestBalanceForAccount(
  expenses: ExpenseRecord[],
  accountName: string,
  beginningBalances?: OnboardingBeginningBalance[],
  bankAccountId?: string,
) {
  const matches = expenses
    .filter(
      (expense) =>
        expense.bank_account_name?.trim().toLowerCase() === accountName.trim().toLowerCase() &&
        expense.balance_after_transaction != null,
    )
    .sort((a, b) => parseExpenseSortDate(b).localeCompare(parseExpenseSortDate(a)));
  if (matches.length > 0) {
    const value = matches[0].balance_after_transaction;
    const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  // Fall back to beginning balance if no expense balance exists
  if (beginningBalances) {
    const opening = beginningBalances.find(
      (b) =>
        (bankAccountId != null && b.account_id === bankAccountId) ||
        normalizeName(b.account_name) === normalizeName(accountName),
    );
    if (opening) return opening.beginning_balance;
  }
  return null;
}

function buildDisplayBankRows(bankAccounts: BankAccount[], externalAccounts: ExternalPlaidAccount[]): DisplayBankRow[] {
  const matchedPlaidIds = new Set<string>();
  const rows: DisplayBankRow[] = bankAccounts.map((bank) => {
    const plaid = matchPlaidAccount(bank, externalAccounts);
    if (plaid) matchedPlaidIds.add(plaid.id);
    return { source: "bank", bank, plaid };
  });
  for (const plaid of externalAccounts) {
    if (!matchedPlaidIds.has(plaid.id)) {
      rows.push({ source: "plaid", plaid, bank: null });
    }
  }
  return rows;
}

const SETTINGS_OVERVIEW_ACCOUNT_LIMIT = 4;

const SETTINGS_OVERVIEW_MANAGEMENT_CARDS: {
  id: SettingsSectionId;
  title: string;
  description: string;
  cta: string;
}[] = [
  {
    id: "members",
    title: "Department Members",
    description: "Invite members, manage roles, and control access.",
    cta: "Manage members",
  },
  {
    id: "categories",
    title: "Categories",
    description: "Create and organize categories for transactions.",
    cta: "Manage categories",
  },
  {
    id: "permissions",
    title: "Permissions & Approvals",
    description: "Set approval rules, spending limits, and review requirements.",
    cta: "Manage permissions",
  },
  {
    id: "compliance",
    title: "Compliance",
    description: "Stay ready for NYS 2%, IRS 990, and audit reporting.",
    cta: "View compliance",
  },
  {
    id: "notifications",
    title: "Notifications",
    description: "Choose reminders and alerts for important activity.",
    cta: "Manage notifications",
  },
  {
    id: "security",
    title: "Security",
    description: "Manage password, sessions, and account protection.",
    cta: "Manage security",
  },
];

type PlaidOverviewStatus = "connected" | "not_connected" | "needs_reconnect";

function formatAccountTypeLabel(row: DisplayBankRow) {
  if (row.source !== "plaid") return null;
  const raw = (row.plaid.subtype || row.plaid.type || "").trim();
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/_/g, " ");
  const labels: Record<string, string> = {
    checking: "Checking",
    savings: "Savings",
    "money market": "Money Market",
    cd: "CD",
    "credit card": "Credit Card",
    paypal: "PayPal",
    prepaid: "Prepaid",
    depository: "Depository",
    credit: "Credit",
    loan: "Loan",
    brokerage: "Brokerage",
    "2% funds": "2% Funds",
  };
  return labels[key] || raw.replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatAccountSubline(row: DisplayBankRow) {
  const institution =
    row.source === "bank" ? row.bank.institution_name?.trim() || "Manual account" : "Plaid";
  const mask = row.source === "bank" ? row.bank.account_mask : row.plaid.mask;
  if (mask?.trim()) {
    const maskLabel = `•••• ${mask.trim()}`;
    return institution === "Plaid" || institution === "Manual account" ? maskLabel : `${institution} ${maskLabel}`;
  }
  return institution;
}

function getPlaidOverviewStatus(
  row: DisplayBankRow,
  plaidConnected: boolean,
  hasPlaidConnection: boolean,
): PlaidOverviewStatus {
  if (plaidConnected) return "connected";
  if (row.source === "bank" && hasPlaidConnection) return "needs_reconnect";
  return "not_connected";
}

function formatOverviewDateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function getDisplayRowMeta(
  row: DisplayBankRow,
  expenses: ExpenseRecord[],
  plaidSyncedAt: string | null,
  beginningBalances?: OnboardingBeginningBalance[],
) {
  const name = row.source === "bank" ? row.bank.name : row.plaid.name;
  const institution =
    row.source === "bank" ? row.bank.institution_name || "Manual account" : `Plaid · ${row.plaid.type}`;
  const mask = row.source === "bank" ? row.bank.account_mask : row.plaid.mask;
  const isDefault = row.source === "bank" && row.bank.is_default;
  const plaidMatch = row.source === "bank" ? row.plaid : row.plaid;
  const plaidConnected = Boolean(plaidMatch);
  const bankId = row.source === "bank" ? row.bank.id : null;
  const balance = latestBalanceForAccount(expenses, name, beginningBalances, bankId ?? undefined);
  const lastSynced = plaidConnected ? plaidSyncedAt || plaidMatch?.created_at : null;
  const id = row.source === "bank" ? row.bank.id : row.plaid.id;
  const accountType = formatAccountTypeLabel(row);
  const subline = formatAccountSubline(row);
  return { name, institution, mask, isDefault, plaidConnected, balance, lastSynced, bankId, id, accountType, subline };
}

function getOverviewRowMeta(
  row: DisplayBankRow,
  expenses: ExpenseRecord[],
  plaidSyncedAt: string | null,
  hasPlaidConnection: boolean,
  beginningBalances?: OnboardingBeginningBalance[],
) {
  const base = getDisplayRowMeta(row, expenses, plaidSyncedAt, beginningBalances);
  const plaidStatus = getPlaidOverviewStatus(row, base.plaidConnected, hasPlaidConnection);
  return {
    ...base,
    plaidStatus,
    lastSyncedLabel: formatOverviewDateTime(base.lastSynced),
  };
}

function SettingsOverviewPlaidPill({
  status,
  onConnect,
}: {
  status: PlaidOverviewStatus;
  onConnect: () => void;
}) {
  const label =
    status === "connected" ? "Connected" : status === "needs_reconnect" ? "Needs reconnect" : "Not connected";
  const tone = status === "connected" ? "success" : status === "needs_reconnect" ? "warning" : "neutral";

  if (status === "connected") {
    return <SettingsStatusPill tone={tone}>{label}</SettingsStatusPill>;
  }

  return (
    <button type="button" className={`fb-settings-pill fb-settings-pill--${tone} fb-settings-pill-btn`} onClick={onConnect}>
      {label}
    </button>
  );
}

function SettingsStatusPill({
  tone,
  children,
}: {
  tone: "success" | "neutral" | "warning" | "primary";
  children: ReactNode;
}) {
  return <span className={`fb-settings-pill fb-settings-pill--${tone}`}>{children}</span>;
}

function Settings({
  membership,
  session,
  user,
  bankAccounts,
  expenses,
  departmentSettings,
  departmentCategories,
  activeSection,
  onSectionChange,
  onBankAccountsChanged,
  onDepartmentSettingsChanged,
  onCategoriesChanged,
  onVendorsChanged,
  onBeginningBalancesChanged,
  showErrorMessage,
  showSuccessMessage,
  showTwoPercentPanel,
  onTwoPercentPanelToggle,
}: {
  membership: DepartmentMembership;
  session: Session;
  user: User;
  bankAccounts: BankAccount[];
  expenses: ExpenseRecord[];
  departmentSettings: DepartmentSetting | null;
  departmentCategories: DepartmentCategory[];
  activeSection: SettingsSectionId;
  onSectionChange: (section: SettingsSectionId) => void;
  onBankAccountsChanged: () => Promise<void>;
  onDepartmentSettingsChanged: () => Promise<void>;
  onCategoriesChanged: () => Promise<void>;
  onVendorsChanged: () => Promise<void>;
  onBeginningBalancesChanged: () => Promise<void>;
  showErrorMessage: (message: string) => void;
  showSuccessMessage: (message: string | null) => void;
  showTwoPercentPanel: boolean;
  onTwoPercentPanelToggle: (value: boolean) => void;
}) {
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [plaidLinkToken, setPlaidLinkToken] = useState<string | null>(null);
  const [syncWorking, setSyncWorking] = useState(false);
  const [externalAccounts, setExternalAccounts] = useState<ExternalPlaidAccount[]>([]);
  const [plaidSyncedAt, setPlaidSyncedAt] = useState<string | null>(null);
  const [departmentMembers, setDepartmentMembers] = useState<DepartmentMemberRow[]>([]);

  // Onboarding state
  const [onboardingStep, setOnboardingStep] = useState<1 | 2 | 3>(1);
  const [onboardingLoading, setOnboardingLoading] = useState(false);
  const [beginningBalances, setBeginningBalances] = useState<OnboardingBeginningBalance[]>([]);
  const [showAddBalance, setShowAddBalance] = useState(false);
  const [balanceFormDefaults, setBalanceFormDefaults] = useState<{
    account_id?: string;
    account_name?: string;
    institution?: string;
    mask?: string;
  }>({});
  const [balanceSaving, setBalanceSaving] = useState(false);
  const [priorUploads, setPriorUploads] = useState<OnboardingPriorRecordUpload[]>([]);
  const [uploadWorking, setUploadWorking] = useState(false);
  const [suggestions, setSuggestions] = useState<OnboardingSuggestion[]>([]);
  const [renamingSuggestionId, setRenamingSuggestionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [suggestionWorking, setSuggestionWorking] = useState<string | null>(null);

  const categories = useMemo(() => {
    const fromExpenses = uniqueCategoriesFromExpenses(expenses);
    const fromDept = departmentCategories.map((c) => c.name);
    const seen = new Set(fromExpenses.map((c) => c.toLowerCase()));
    const extras = fromDept.filter((c) => !seen.has(c.toLowerCase()));
    return [...fromExpenses, ...extras].sort((a, b) => a.localeCompare(b));
  }, [expenses, departmentCategories]);
  const displayRows = useMemo(
    () => buildDisplayBankRows(bankAccounts, externalAccounts),
    [bankAccounts, externalAccounts],
  );
  const connectedAccountCount = displayRows.length;
  const memberCount = Math.max(departmentMembers.length, 1);
  const hasPlaidConnection = externalAccounts.length > 0;
  const isCompliant =
    connectedAccountCount > 0 && categories.length > 0 && Boolean(membership.departments?.setup_completed_at);

  const { open: openPlaid, ready: plaidReady } = usePlaidLink({
    token: plaidLinkToken || "",
    onSuccess: async (public_token) => {
      const exchangeResponse = await fetch("/api/plaid/exchange-public-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicToken: public_token,
          departmentId: membership.department_id,
        }),
      });
      const exchangePayload = (await exchangeResponse.json()) as { error?: string; accounts?: number };
      if (!exchangeResponse.ok) {
        showErrorMessage(exchangePayload.error || "Could not connect Plaid account.");
        return;
      }
      await onBankAccountsChanged();
      await loadPlaidData();
      showSuccessMessage(`Plaid connected. Imported ${exchangePayload.accounts || 0} accounts.`);
    },
  });

  const loadPlaidData = useCallback(async () => {
    const { data: accounts } = await supabase
      .from("external_accounts")
      .select("id,name,mask,type,subtype,created_at")
      .eq("department_id", membership.department_id)
      .order("created_at", { ascending: true });
    setExternalAccounts((accounts as ExternalPlaidAccount[] | null) || []);

    const { data: txRow } = await supabase
      .from("external_transactions")
      .select("created_at")
      .eq("department_id", membership.department_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    setPlaidSyncedAt((txRow as { created_at?: string } | null)?.created_at || null);
  }, [membership.department_id]);

  const loadMembers = useCallback(async () => {
    const { data } = await supabase
      .from("department_members")
      .select("user_id,role,created_at")
      .eq("department_id", membership.department_id)
      .order("created_at", { ascending: true });
    setDepartmentMembers((data as DepartmentMemberRow[] | null) || []);
  }, [membership.department_id]);

  const loadBeginningBalances = useCallback(async () => {
    const { data } = await supabase
      .from("onboarding_beginning_balances")
      .select("*")
      .eq("department_id", membership.department_id)
      .order("created_at", { ascending: true });
    setBeginningBalances((data as OnboardingBeginningBalance[] | null) ?? []);
  }, [membership.department_id]);

  const loadPriorUploads = useCallback(async () => {
    const { data } = await supabase
      .from("onboarding_prior_record_uploads")
      .select("*")
      .eq("department_id", membership.department_id)
      .order("created_at", { ascending: false });
    setPriorUploads((data as OnboardingPriorRecordUpload[] | null) ?? []);
  }, [membership.department_id]);

  const loadSuggestions = useCallback(async () => {
    const { data } = await supabase
      .from("onboarding_suggestions")
      .select("*")
      .eq("department_id", membership.department_id)
      .order("created_at", { ascending: true });
    setSuggestions((data as OnboardingSuggestion[] | null) ?? []);
  }, [membership.department_id]);

  const loadOnboardingData = useCallback(async () => {
    setOnboardingLoading(true);
    try {
      await Promise.all([loadBeginningBalances(), loadPriorUploads(), loadSuggestions()]);
    } finally {
      setOnboardingLoading(false);
    }
  }, [loadBeginningBalances, loadPriorUploads, loadSuggestions]);

  useEffect(() => {
    void loadPlaidData();
    void loadMembers();
  }, [loadMembers, loadPlaidData]);

  useEffect(() => {
    if (activeSection === "onboarding") {
      void loadOnboardingData();
    }
  }, [activeSection, loadOnboardingData]);

  async function startPlaidLink() {
    const response = await fetch("/api/plaid/create-link-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: session.user.id,
        departmentId: membership.department_id,
      }),
    });
    const payload = (await response.json()) as { link_token?: string; error?: string };
    if (!response.ok || !payload.link_token) {
      showErrorMessage(payload.error || "Could not create Plaid link token.");
      return;
    }
    setPlaidLinkToken(payload.link_token);
  }

  useEffect(() => {
    if (plaidLinkToken && plaidReady) {
      openPlaid();
    }
  }, [openPlaid, plaidLinkToken, plaidReady]);

  async function syncPlaidTransactions() {
    setSyncWorking(true);
    const response = await fetch("/api/plaid/sync-transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ departmentId: membership.department_id }),
    });
    const payload = (await response.json()) as { error?: string; inserted?: number; matched?: number };
    if (!response.ok) {
      showErrorMessage(payload.error || "Could not sync Plaid transactions.");
      setSyncWorking(false);
      return;
    }
    await loadPlaidData();
    showSuccessMessage(`Synced ${payload.inserted || 0} transactions, matched ${payload.matched || 0}.`);
    setSyncWorking(false);
  }

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = String(form.get("name") || "").trim();
    const institution = String(form.get("institution_name") || "").trim();
    const accountMask = String(form.get("account_mask") || "").trim();
    const isDefault = String(form.get("is_default") || "") === "on";
    const isTwoPct = String(form.get("is_two_percent_account") || "") === "on";
    if (!name) return;
    if (isTwoPct) {
      const existingCount = bankAccounts.filter((a) => a.is_two_percent_account).length;
      if (existingCount > 0) {
        const confirmed = window.confirm(
          "Most departments use a separate account for 2% funds. Are you sure you want more than one 2% account?",
        );
        if (!confirmed) return;
      }
    }
    if (isDefault) {
      await supabase
        .from("bank_accounts")
        .update({ is_default: false })
        .eq("department_id", membership.department_id);
    }
    const { error } = await supabase.from("bank_accounts").insert({
      department_id: membership.department_id,
      name,
      institution_name: institution || null,
      account_mask: accountMask || null,
      is_default: isDefault,
      is_two_percent_account: isTwoPct,
      fund_type: isTwoPct ? "nys_2_percent" : null,
    });
    if (error) {
      showErrorMessage(error.message);
      return;
    }
    const setupResponse = await fetch("/api/complete-department-setup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ departmentId: membership.department_id }),
    });
    formElement.reset();
    setShowAddAccount(false);
    await onBankAccountsChanged();
    if (!setupResponse.ok) {
      const setupPayload = (await setupResponse.json()) as { error?: string };
      showErrorMessage(
        `Bank account saved, but setup status was not updated: ${setupPayload.error || setupResponse.statusText}. Check server env (SUPABASE_SERVICE_ROLE_KEY).`,
      );
      return;
    }
    showSuccessMessage("Bank account saved.");
  }

  async function makeDefault(accountId: string) {
    await supabase.from("bank_accounts").update({ is_default: false }).eq("department_id", membership.department_id);
    const { error } = await supabase.from("bank_accounts").update({ is_default: true }).eq("id", accountId);
    if (error) {
      showErrorMessage(error.message);
      return;
    }
    await onBankAccountsChanged();
    showSuccessMessage("Default account updated.");
  }

  async function setTwoPercentAccount(accountId: string, value: boolean) {
    if (value) {
      const existingCount = bankAccounts.filter((a) => a.is_two_percent_account && a.id !== accountId).length;
      if (existingCount > 0) {
        const confirmed = window.confirm(
          "Most departments use a separate account for 2% funds. Are you sure you want more than one 2% account?",
        );
        if (!confirmed) return;
      }
    }
    const { error } = await supabase
      .from("bank_accounts")
      .update({ is_two_percent_account: value, fund_type: value ? "nys_2_percent" : null })
      .eq("id", accountId);
    if (error) {
      showErrorMessage(error.message);
      return;
    }
    await onBankAccountsChanged();
    showSuccessMessage(value ? "Account tagged as 2% Funds account." : "2% Funds tag removed.");
  }

  async function toggleAutoLog(autoLog: boolean) {
    const { error } = await supabase.from("department_settings").upsert({
      department_id: membership.department_id,
      auto_log_statement_expenses: autoLog,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      showErrorMessage(error.message);
      return;
    }
    await onDepartmentSettingsChanged();
    showSuccessMessage("Statement auto-log setting saved.");
  }

  // ── Onboarding actions ────────────────────────────────────────────────────

  async function saveBeginningBalance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const accountName = ((data.get("account_name") as string) || "").trim();
    const accountType = ((data.get("account_type") as string) || "").trim();
    const institution = ((data.get("institution") as string) || "").trim();
    const mask = ((data.get("mask") as string) || "").trim();
    const balanceRaw = ((data.get("beginning_balance") as string) || "").replace(/[$,]/g, "");
    const balanceDate = ((data.get("balance_date") as string) || "").trim();
    const isDefault = data.get("is_default") === "on";

    if (!accountName || !accountType || !balanceRaw || !balanceDate) {
      showErrorMessage("Account name, type, balance, and date are required.");
      return;
    }
    const balance = parseFloat(balanceRaw);
    if (!Number.isFinite(balance)) {
      showErrorMessage("Enter a valid balance amount.");
      return;
    }

    setBalanceSaving(true);
    try {
      // Find or create the corresponding bank_account record
      let resolvedAccountId: string | null = balanceFormDefaults.account_id ?? null;
      let createdNewAccount = false;
      if (!resolvedAccountId) {
        const normalized = normalizeName(accountName);
        const existingAccount = bankAccounts.find((a) => normalizeName(a.name) === normalized);
        if (existingAccount) {
          resolvedAccountId = existingAccount.id;
        } else {
          const { data: newAccount, error: accountError } = await supabase
            .from("bank_accounts")
            .insert({
              department_id: membership.department_id,
              name: accountName,
              institution_name: institution || null,
              account_mask: mask || null,
              is_default: isDefault,
            })
            .select()
            .single();
          if (accountError) throw accountError;
          resolvedAccountId = (newAccount as { id: string }).id;
          createdNewAccount = true;
          await onBankAccountsChanged();
        }
      }

      const { error } = await supabase.from("onboarding_beginning_balances").insert({
        department_id: membership.department_id,
        account_id: resolvedAccountId,
        account_name: accountName,
        account_type: accountType,
        institution: institution || null,
        mask: mask || null,
        beginning_balance: balance,
        balance_date: balanceDate,
        is_default: isDefault,
        created_by: user.id,
      });
      if (error) throw error;
      form.reset();
      setShowAddBalance(false);
      setBalanceFormDefaults({});
      await loadBeginningBalances();
      await onBeginningBalancesChanged();
      const msg = createdNewAccount
        ? `Account "${accountName}" created and beginning balance saved.`
        : "Beginning balances saved and applied to your accounts.";
      showSuccessMessage(msg);
    } catch (err) {
      showErrorMessage(err instanceof Error ? err.message : "Could not save balance.");
    } finally {
      setBalanceSaving(false);
    }
  }

  async function deleteBeginningBalance(id: string) {
    const { error } = await supabase.from("onboarding_beginning_balances").delete().eq("id", id);
    if (error) {
      showErrorMessage("Could not remove balance.");
      return;
    }
    await loadBeginningBalances();
    await onBeginningBalancesChanged();
  }

  async function uploadPriorRecord(file: File) {
    setUploadWorking(true);
    const uploadId = crypto.randomUUID();
    const safeName = file.name.replace(/[^a-z0-9._-]/gi, "_");
    const filePath = `${membership.department_id}/prior-records/${uploadId}-${safeName}`;

    try {
      const { error: storageError } = await supabase.storage
        .from("onboarding")
        .upload(filePath, file, { contentType: file.type || "application/octet-stream" });
      if (storageError) throw storageError;

      const { data: uploadRecord, error: dbError } = await supabase
        .from("onboarding_prior_record_uploads")
        .insert({
          department_id: membership.department_id,
          file_path: filePath,
          file_name: file.name,
          file_mime_type: file.type || null,
          status: "processing",
          created_by: user.id,
        })
        .select()
        .single();
      if (dbError) throw dbError;

      const { data: signedUrlData } = await supabase.storage
        .from("onboarding")
        .createSignedUrl(filePath, 300);

      let extractedData: Record<string, unknown> | null = null;
      let newStatus: "reviewed" | "failed" = "reviewed";
      try {
        const response = await fetch("/api/extract-onboarding-records", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file_url: signedUrlData?.signedUrl,
            filename: file.name,
            content_type: file.type || "application/octet-stream",
          }),
        });
        if (response.ok) {
          extractedData = (await response.json()) as Record<string, unknown>;
          await createSuggestionsFromExtraction(
            (uploadRecord as { id: string }).id,
            extractedData,
          );
        } else {
          newStatus = "failed";
        }
      } catch {
        newStatus = "failed";
      }

      await supabase
        .from("onboarding_prior_record_uploads")
        .update({
          status: newStatus,
          extracted_data: extractedData,
          updated_at: new Date().toISOString(),
        })
        .eq("id", (uploadRecord as { id: string }).id);

      await loadOnboardingData();
      showSuccessMessage(
        `Uploaded ${file.name}${newStatus === "reviewed" ? " — suggestions generated." : "."}`,
      );
    } catch (err) {
      showErrorMessage(err instanceof Error ? err.message : "Upload failed.");
      await loadPriorUploads();
    } finally {
      setUploadWorking(false);
    }
  }

  async function createSuggestionsFromExtraction(
    uploadId: string,
    data: Record<string, unknown>,
  ) {
    type SuggestionInsert = {
      department_id: string;
      suggestion_type: "account" | "category" | "vendor" | "income_type";
      suggested_value: string;
      confidence: number | null;
      source_upload_id: string;
      status: "pending";
    };
    const toInsert: SuggestionInsert[] = [];
    const existingKeys = new Set(
      suggestions.map((s) => `${s.suggestion_type}:${s.suggested_value.toLowerCase()}`),
    );
    const conf = typeof data.confidence === "number" ? data.confidence : null;

    const addGroup = (
      values: unknown,
      type: SuggestionInsert["suggestion_type"],
    ) => {
      if (!Array.isArray(values)) return;
      for (const v of values as string[]) {
        const key = `${type}:${v.toLowerCase()}`;
        if (v.trim() && !existingKeys.has(key)) {
          existingKeys.add(key);
          toInsert.push({
            department_id: membership.department_id,
            suggestion_type: type,
            suggested_value: v.trim(),
            confidence: conf,
            source_upload_id: uploadId,
            status: "pending",
          });
        }
      }
    };

    addGroup(data.accounts, "account");
    addGroup(data.categories, "category");
    addGroup(data.vendors, "vendor");
    addGroup(data.income_types, "income_type");

    if (toInsert.length > 0) {
      await supabase.from("onboarding_suggestions").insert(toInsert);
    }
  }

  async function acceptSuggestion(suggestion: OnboardingSuggestion) {
    const value = suggestion.suggested_value.trim();
    setSuggestionWorking(suggestion.id);
    try {
      let feedbackMsg = `"${value}" accepted.`;

      if (suggestion.suggestion_type === "category" || suggestion.suggestion_type === "income_type") {
        const normalized = normalizeName(value);
        const { data: existing } = await supabase
          .from("department_categories")
          .select("id, name")
          .eq("department_id", membership.department_id)
          .eq("normalized_name", normalized)
          .maybeSingle();
        if (existing) {
          feedbackMsg = `Matched existing category: "${(existing as { name: string }).name}"`;
        } else {
          const { error } = await supabase.from("department_categories").insert({
            department_id: membership.department_id,
            name: value,
            normalized_name: normalized,
            created_from: "onboarding",
          });
          if (error) throw error;
          feedbackMsg = `"${value}" added to Categories.`;
          await onCategoriesChanged();
        }
      } else if (suggestion.suggestion_type === "vendor") {
        const normalized = normalizeName(value);
        const { data: existing } = await supabase
          .from("department_vendors")
          .select("id, name")
          .eq("department_id", membership.department_id)
          .eq("normalized_name", normalized)
          .maybeSingle();
        if (existing) {
          feedbackMsg = `Matched existing vendor: "${(existing as { name: string }).name}"`;
        } else {
          const { error } = await supabase.from("department_vendors").insert({
            department_id: membership.department_id,
            name: value,
            normalized_name: normalized,
            created_from: "onboarding",
          });
          if (error) throw error;
          feedbackMsg = `"${value}" added to Vendors.`;
          await onVendorsChanged();
        }
      } else if (suggestion.suggestion_type === "account") {
        const normalized = normalizeName(value);
        const existingAccount = bankAccounts.find((a) => normalizeName(a.name) === normalized);
        if (existingAccount) {
          feedbackMsg = `Matched existing account: "${existingAccount.name}"`;
        } else {
          const { error } = await supabase.from("bank_accounts").insert({
            department_id: membership.department_id,
            name: value,
            institution_name: null,
            account_mask: null,
            is_default: false,
          });
          if (error) throw error;
          await onBankAccountsChanged();
          feedbackMsg = `"${value}" added to Accounts.`;
        }
      }

      const { error } = await supabase
        .from("onboarding_suggestions")
        .update({
          status: "accepted",
          accepted_value: value,
          updated_at: new Date().toISOString(),
        })
        .eq("id", suggestion.id);
      if (error) throw error;
      await loadSuggestions();
      showSuccessMessage(feedbackMsg);
    } catch (err) {
      showErrorMessage(err instanceof Error ? err.message : "Could not accept suggestion.");
    } finally {
      setSuggestionWorking(null);
    }
  }

  async function ignoreSuggestion(id: string) {
    setSuggestionWorking(id);
    try {
      const { error } = await supabase
        .from("onboarding_suggestions")
        .update({ status: "ignored", updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
      await loadSuggestions();
    } catch (err) {
      showErrorMessage(err instanceof Error ? err.message : "Could not ignore suggestion.");
    } finally {
      setSuggestionWorking(null);
    }
  }

  async function confirmRenameSuggestion(suggestion: OnboardingSuggestion) {
    const finalValue = renameValue.trim();
    if (!finalValue) return;
    setSuggestionWorking(suggestion.id);
    try {
      // Write the renamed value to the same real table as acceptSuggestion
      if (suggestion.suggestion_type === "category" || suggestion.suggestion_type === "income_type") {
        const normalized = normalizeName(finalValue);
        const { data: existing } = await supabase
          .from("department_categories")
          .select("id")
          .eq("department_id", membership.department_id)
          .eq("normalized_name", normalized)
          .maybeSingle();
        if (!existing) {
          const { error } = await supabase.from("department_categories").insert({
            department_id: membership.department_id,
            name: finalValue,
            normalized_name: normalized,
            created_from: "onboarding",
          });
          if (error) throw error;
          await onCategoriesChanged();
        }
      } else if (suggestion.suggestion_type === "vendor") {
        const normalized = normalizeName(finalValue);
        const { data: existing } = await supabase
          .from("department_vendors")
          .select("id")
          .eq("department_id", membership.department_id)
          .eq("normalized_name", normalized)
          .maybeSingle();
        if (!existing) {
          const { error } = await supabase.from("department_vendors").insert({
            department_id: membership.department_id,
            name: finalValue,
            normalized_name: normalized,
            created_from: "onboarding",
          });
          if (error) throw error;
          await onVendorsChanged();
        }
      } else if (suggestion.suggestion_type === "account") {
        const normalized = normalizeName(finalValue);
        const exists = bankAccounts.some((a) => normalizeName(a.name) === normalized);
        if (!exists) {
          const { error } = await supabase.from("bank_accounts").insert({
            department_id: membership.department_id,
            name: finalValue,
            institution_name: null,
            account_mask: null,
            is_default: false,
          });
          if (error) throw error;
          await onBankAccountsChanged();
        }
      }

      const { error } = await supabase
        .from("onboarding_suggestions")
        .update({
          status: "renamed",
          accepted_value: finalValue,
          updated_at: new Date().toISOString(),
        })
        .eq("id", suggestion.id);
      if (error) throw error;
      setRenamingSuggestionId(null);
      setRenameValue("");
      await loadSuggestions();
      showSuccessMessage(`Saved as "${finalValue}".`);
    } catch (err) {
      showErrorMessage(err instanceof Error ? err.message : "Could not rename suggestion.");
    } finally {
      setSuggestionWorking(null);
    }
  }

  // ── Onboarding render helpers ─────────────────────────────────────────────

  function renderBeginningBalancesStep() {
    return (
      <section className="card fb-settings-panel-card">
        <div className="fb-settings-panel-head">
          <div>
            <h2 className="fb-settings-panel-title">Beginning Balances</h2>
            <p className="fb-settings-panel-subtitle">
              Enter the balances you are starting with in Firebook. These are used as your opening
              balances before Firebook starts tracking activity.
            </p>
          </div>
          {!showAddBalance && (
            <button
              type="button"
              className="fb-primary-btn"
              onClick={() => {
                setBalanceFormDefaults({});
                setShowAddBalance(true);
              }}
            >
              Add account
            </button>
          )}
        </div>

        <div className="fb-onboarding-note">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <p>
            If you connect an account through Plaid, future transactions and balances will sync
            automatically.
          </p>
        </div>

        {bankAccounts.length > 0 && (
          <div className="fb-onboarding-existing-section">
            <p className="fb-onboarding-section-label">Your Firebook accounts</p>
            <div className="fb-onboarding-account-list">
              {bankAccounts.map((account) => {
                const existingBalance = beginningBalances.find(
                  (b) =>
                    b.account_id === account.id ||
                    b.account_name.toLowerCase().trim() ===
                      account.name.toLowerCase().trim(),
                );
                return (
                  <div key={account.id} className="fb-onboarding-account-row">
                    <div className="fb-onboarding-account-info">
                      <p className="fb-onboarding-account-name">{account.name}</p>
                      <p className="fb-onboarding-account-meta">
                        {[
                          account.institution_name || "Manual account",
                          account.account_mask ? `•••• ${account.account_mask}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    {existingBalance ? (
                      <div className="fb-onboarding-balance-badge">
                        <span>{formatUsd(existingBalance.beginning_balance)}</span>
                        <span className="muted">
                          as of {formatSettingsDate(existingBalance.balance_date)}
                        </span>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="fb-secondary-btn"
                        onClick={() => {
                          setBalanceFormDefaults({
                            account_id: account.id,
                            account_name: account.name,
                            institution: account.institution_name || "",
                            mask: account.account_mask || "",
                          });
                          setShowAddBalance(true);
                        }}
                      >
                        Add balance
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {showAddBalance && (
          <form
            className="fb-onboarding-balance-form"
            onSubmit={(e) => void saveBeginningBalance(e)}
          >
            <div className="fb-onboarding-balance-form-header">
              <h3 className="fb-onboarding-form-title">
                {balanceFormDefaults.account_name
                  ? `Add balance — ${balanceFormDefaults.account_name}`
                  : "Add beginning balance"}
              </h3>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setShowAddBalance(false);
                  setBalanceFormDefaults({});
                }}
              >
                Cancel
              </button>
            </div>
            <div className="fb-onboarding-form-grid">
              <label>
                Account name
                <input
                  name="account_name"
                  required
                  placeholder="Operating Checking"
                  defaultValue={balanceFormDefaults.account_name || ""}
                  key={`name-${balanceFormDefaults.account_name || "new"}`}
                />
              </label>
              <label>
                Account type
                <select name="account_type" required defaultValue="">
                  <option value="" disabled>
                    Select type
                  </option>
                  <option value="Checking">Checking</option>
                  <option value="Savings">Savings</option>
                  <option value="2% Funds">2% Funds</option>
                  <option value="Credit Card">Credit Card</option>
                  <option value="Cash">Cash</option>
                  <option value="Other">Other</option>
                </select>
              </label>
              <label>
                Institution
                <input
                  name="institution"
                  placeholder="Chase, M&T, etc."
                  defaultValue={balanceFormDefaults.institution || ""}
                  key={`inst-${balanceFormDefaults.institution || "new"}`}
                />
              </label>
              <label>
                Last four / mask
                <input
                  name="mask"
                  placeholder="1234"
                  maxLength={4}
                  defaultValue={balanceFormDefaults.mask || ""}
                  key={`mask-${balanceFormDefaults.mask || "new"}`}
                />
              </label>
              <label>
                Beginning balance
                <input
                  name="beginning_balance"
                  type="text"
                  required
                  inputMode="decimal"
                  placeholder="0.00"
                />
              </label>
              <label>
                Balance date
                <input name="balance_date" type="date" required />
              </label>
            </div>
            <label className="fb-settings-checkbox">
              <input type="checkbox" name="is_default" />
              <span>Set as default account</span>
            </label>
            <div className="fb-onboarding-form-actions">
              <button type="submit" className="fb-primary-btn" disabled={balanceSaving}>
                {balanceSaving ? "Saving…" : "Save beginning balance"}
              </button>
              <button
                type="button"
                className="fb-secondary-btn"
                onClick={() => {
                  setShowAddBalance(false);
                  setBalanceFormDefaults({});
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {beginningBalances.length > 0 && (
          <div className="fb-onboarding-balance-list">
            <p className="fb-onboarding-section-label">Saved beginning balances</p>
            {beginningBalances.map((bal) => (
              <div key={bal.id} className="fb-onboarding-balance-row">
                <div className="fb-onboarding-balance-info">
                  <p className="fb-onboarding-account-name">{bal.account_name}</p>
                  <p className="fb-onboarding-account-meta">
                    {[bal.account_type, bal.institution, bal.mask ? `•••• ${bal.mask}` : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <div className="fb-onboarding-balance-badge">
                  <span>{formatUsd(bal.beginning_balance)}</span>
                  <span className="muted">as of {formatSettingsDate(bal.balance_date)}</span>
                  {bal.is_default ? <SettingsStatusPill tone="primary">Default</SettingsStatusPill> : null}
                </div>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => void deleteBeginningBalance(bal.id)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        {beginningBalances.length === 0 && !showAddBalance && (
          <p className="empty-state">
            No beginning balances added yet.{" "}
            {bankAccounts.length ? "Use the buttons above or add a new account." : 'Click "Add account" to get started.'}
          </p>
        )}

        <div className="fb-onboarding-step-footer">
          <button
            type="button"
            className="fb-primary-btn"
            onClick={() => {
              setOnboardingStep(2);
              void loadOnboardingData();
            }}
          >
            Continue to Upload Records
          </button>
        </div>
      </section>
    );
  }

  function renderUploadPriorRecordsStep() {
    const STATUS_LABEL: Record<string, string> = {
      uploaded: "Uploaded",
      processing: "Processing",
      reviewed: "Reviewed",
      failed: "Failed",
    };
    const STATUS_TONE: Record<string, "success" | "neutral" | "warning"> = {
      uploaded: "neutral",
      processing: "neutral",
      reviewed: "success",
      failed: "warning",
    };

    return (
      <section className="card fb-settings-panel-card">
        <div className="fb-settings-panel-head">
          <div>
            <h2 className="fb-settings-panel-title">Upload Prior Records</h2>
            <p className="fb-settings-panel-subtitle">
              Upload photos, PDFs, or spreadsheets of old registers, notebooks, statements, or
              logs. Firebook will use them to suggest categories and accounts.
            </p>
          </div>
        </div>

        <label
          className={`fb-onboarding-upload-zone${uploadWorking ? " fb-onboarding-upload-zone--busy" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            e.currentTarget.classList.add("fb-drag-over");
          }}
          onDragLeave={(e) => e.currentTarget.classList.remove("fb-drag-over")}
          onDrop={(e) => {
            e.preventDefault();
            e.currentTarget.classList.remove("fb-drag-over");
            const files = Array.from(e.dataTransfer.files);
            for (const file of files) {
              void uploadPriorRecord(file);
            }
          }}
        >
          <div className="fb-onboarding-upload-inner">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="36"
              height="36"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="fb-onboarding-upload-icon"
              aria-hidden="true"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <p className="fb-onboarding-upload-label">
              {uploadWorking ? "Uploading…" : "Drag files here or browse"}
            </p>
            <span className="fb-onboarding-upload-btn-wrap">
              <span className="fb-primary-btn fb-onboarding-upload-btn" aria-hidden="true">
                {uploadWorking ? "Uploading…" : "Browse files"}
              </span>
              <input
                type="file"
                multiple
                accept=".jpg,.jpeg,.png,.pdf,.csv,.xlsx,.xls"
                className="fb-onboarding-file-input"
                disabled={uploadWorking}
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  e.target.value = "";
                  for (const file of files) {
                    void uploadPriorRecord(file);
                  }
                }}
              />
            </span>
            <p className="fb-onboarding-upload-hint">
              JPG · PNG · PDF · CSV · XLSX — Registers, notebooks, statements, spreadsheets
            </p>
          </div>
        </label>

        {priorUploads.length > 0 && (
          <div className="fb-onboarding-file-list">
            <p className="fb-onboarding-section-label">Uploaded files</p>
            {priorUploads.map((upload) => (
              <div key={upload.id} className="fb-onboarding-file-row">
                <div className="fb-onboarding-file-info">
                  <p className="fb-onboarding-file-name">{upload.file_name}</p>
                  <p className="fb-onboarding-file-meta">
                    {formatSettingsDate(upload.created_at)}
                  </p>
                </div>
                <SettingsStatusPill tone={STATUS_TONE[upload.status] ?? "neutral"}>
                  {STATUS_LABEL[upload.status] ?? upload.status}
                </SettingsStatusPill>
              </div>
            ))}
          </div>
        )}

        {priorUploads.length === 0 && (
          <p className="muted" style={{ fontSize: "0.88rem" }}>
            No files uploaded yet. Accepted formats include handwritten bank registers, check logs,
            deposit records, prior treasurer notebooks, and spreadsheet exports.
          </p>
        )}

        <div className="fb-onboarding-step-footer">
          <button
            type="button"
            className="fb-primary-btn"
            onClick={() => {
              setOnboardingStep(3);
              void loadOnboardingData();
            }}
          >
            Review Suggestions
          </button>
          <button
            type="button"
            className="fb-secondary-btn"
            onClick={() => setOnboardingStep(1)}
          >
            Back
          </button>
        </div>
      </section>
    );
  }

  function renderReviewSuggestionsStep() {
    const pending = suggestions.filter((s) => s.status === "pending");
    const resolved = suggestions.filter((s) => s.status !== "pending");

    const GROUPS: Array<{
      type: OnboardingSuggestion["suggestion_type"];
      label: string;
    }> = [
      { type: "account", label: "Suggested Accounts" },
      { type: "category", label: "Suggested Categories" },
      { type: "vendor", label: "Suggested Vendors / Payees" },
      { type: "income_type", label: "Suggested Income Types" },
    ];

    return (
      <section className="card fb-settings-panel-card">
        <div className="fb-settings-panel-head">
          <div>
            <h2 className="fb-settings-panel-title">Review Suggestions</h2>
            <p className="fb-settings-panel-subtitle">
              Firebook found possible accounts, categories, vendors, and transaction types from
              your uploaded records. Accept what looks right and ignore the rest.
            </p>
          </div>
        </div>

        {onboardingLoading && <p className="muted">Loading suggestions…</p>}

        {!onboardingLoading && suggestions.length === 0 && (
          <div className="fb-onboarding-empty-suggestions">
            <p className="muted">
              No suggestions yet. Upload prior records in Step 2 and Firebook will generate
              suggestions from them.
            </p>
            <button
              type="button"
              className="fb-secondary-btn"
              onClick={() => setOnboardingStep(2)}
            >
              Go to Upload Records
            </button>
          </div>
        )}

        {!onboardingLoading && pending.length === 0 && resolved.length > 0 && (
          <p className="muted" style={{ padding: "4px 0 8px" }}>
            All suggestions have been reviewed.
          </p>
        )}

        {GROUPS.map(({ type, label }) => {
          const group = pending.filter((s) => s.suggestion_type === type);
          if (!group.length) return null;
          return (
            <div key={type} className="fb-onboarding-suggestion-group">
              <h3 className="fb-onboarding-group-title">{label}</h3>
              <div className="fb-onboarding-suggestion-list">
                {group.map((suggestion) => (
                  <div key={suggestion.id} className="fb-onboarding-suggestion-card">
                    <div className="fb-onboarding-suggestion-main">
                      <p className="fb-onboarding-suggestion-value">
                        {suggestion.suggested_value}
                      </p>
                      {suggestion.confidence != null && (
                        <span className="fb-onboarding-confidence">
                          {Math.round(suggestion.confidence * 100)}% match
                        </span>
                      )}
                    </div>
                    {renamingSuggestionId === suggestion.id ? (
                      <div className="fb-onboarding-rename-form">
                        <input
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          placeholder={suggestion.suggested_value}
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void confirmRenameSuggestion(suggestion);
                            if (e.key === "Escape") {
                              setRenamingSuggestionId(null);
                              setRenameValue("");
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="fb-primary-btn"
                          disabled={
                            !renameValue.trim() ||
                            suggestionWorking === suggestion.id
                          }
                          onClick={() => void confirmRenameSuggestion(suggestion)}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="fb-secondary-btn"
                          onClick={() => {
                            setRenamingSuggestionId(null);
                            setRenameValue("");
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="fb-onboarding-suggestion-actions">
                        <button
                          type="button"
                          className="fb-primary-btn"
                          disabled={suggestionWorking === suggestion.id}
                          onClick={() => void acceptSuggestion(suggestion)}
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          className="fb-secondary-btn"
                          disabled={suggestionWorking === suggestion.id}
                          onClick={() => {
                            setRenamingSuggestionId(suggestion.id);
                            setRenameValue(suggestion.suggested_value);
                          }}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className="link-button"
                          disabled={suggestionWorking === suggestion.id}
                          onClick={() => void ignoreSuggestion(suggestion.id)}
                        >
                          Ignore
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        {resolved.length > 0 && (
          <details className="fb-onboarding-reviewed">
            <summary className="fb-onboarding-reviewed-toggle">
              {resolved.length} reviewed suggestion{resolved.length !== 1 ? "s" : ""}
            </summary>
            <div className="fb-onboarding-suggestion-list fb-onboarding-suggestion-list--resolved">
              {resolved.map((suggestion) => (
                <div
                  key={suggestion.id}
                  className="fb-onboarding-suggestion-card fb-onboarding-suggestion-card--resolved"
                >
                  <div className="fb-onboarding-suggestion-main">
                    <p className="fb-onboarding-suggestion-value">
                      {suggestion.accepted_value || suggestion.suggested_value}
                    </p>
                    {suggestion.accepted_value &&
                      suggestion.accepted_value !== suggestion.suggested_value && (
                        <span className="muted fb-onboarding-original">
                          (was: {suggestion.suggested_value})
                        </span>
                      )}
                  </div>
                  <SettingsStatusPill
                    tone={
                      suggestion.status === "accepted" || suggestion.status === "renamed"
                        ? "success"
                        : "neutral"
                    }
                  >
                    {suggestion.status === "accepted"
                      ? "Accepted"
                      : suggestion.status === "renamed"
                        ? "Renamed"
                        : "Ignored"}
                  </SettingsStatusPill>
                </div>
              ))}
            </div>
          </details>
        )}

        <div className="fb-onboarding-step-footer">
          <button
            type="button"
            className="fb-secondary-btn"
            onClick={() => setOnboardingStep(2)}
          >
            Back
          </button>
        </div>
      </section>
    );
  }

  function renderOnboardingSection() {
    const STEP_LABELS: [string, string, string] = [
      "Beginning Balances",
      "Upload Prior Records",
      "Review Suggestions",
    ];
    return (
      <div className="fb-onboarding-page">
        <nav className="card fb-onboarding-steps" aria-label="Onboarding steps">
          {([1, 2, 3] as const).map((step) => (
            <button
              key={step}
              type="button"
              className={`fb-onboarding-step-btn${onboardingStep === step ? " fb-onboarding-step-btn--active" : ""}`}
              onClick={() => {
                setOnboardingStep(step);
                void loadOnboardingData();
              }}
            >
              <span className="fb-onboarding-step-num">{step}</span>
              <span className="fb-onboarding-step-label">{STEP_LABELS[step - 1]}</span>
            </button>
          ))}
        </nav>
        {onboardingStep === 1 && renderBeginningBalancesStep()}
        {onboardingStep === 2 && renderUploadPriorRecordsStep()}
        {onboardingStep === 3 && renderReviewSuggestionsStep()}
      </div>
    );
  }

  function renderSummaryCards() {
    return (
      <div className="fb-settings-summary-grid">
        <button type="button" className="fb-settings-summary-card" onClick={() => onSectionChange("bank_accounts")}>
          <p className="fb-settings-summary-label">Connected Accounts</p>
          <p className="fb-settings-summary-value">{connectedAccountCount}</p>
        </button>
        <button type="button" className="fb-settings-summary-card" onClick={() => onSectionChange("members")}>
          <p className="fb-settings-summary-label">Department Members</p>
          <p className="fb-settings-summary-value">{memberCount}</p>
        </button>
        <button type="button" className="fb-settings-summary-card" onClick={() => onSectionChange("categories")}>
          <p className="fb-settings-summary-label">Categories</p>
          <p className="fb-settings-summary-value">{categories.length}</p>
        </button>
        <button type="button" className="fb-settings-summary-card" onClick={() => onSectionChange("compliance")}>
          <p className="fb-settings-summary-label">Compliant</p>
          <p className="fb-settings-summary-value">{isCompliant ? "Yes" : "Review"}</p>
          {!isCompliant ? <SettingsStatusPill tone="warning">Needs attention</SettingsStatusPill> : <SettingsStatusPill tone="success">Compliant</SettingsStatusPill>}
        </button>
      </div>
    );
  }

  function renderOverviewBankAccountsPreview() {
    const previewRows = displayRows.slice(0, SETTINGS_OVERVIEW_ACCOUNT_LIMIT);
    const hasMore = displayRows.length > SETTINGS_OVERVIEW_ACCOUNT_LIMIT;

    return (
      <section className="card fb-settings-panel-card fb-settings-overview-accounts">
        <div className="fb-settings-panel-head">
          <div>
            <h2 className="fb-settings-panel-title">Connected Bank Accounts</h2>
            <p className="fb-settings-panel-subtitle">Manage and connect your department&apos;s bank accounts.</p>
          </div>
          {displayRows.length ? (
            <button type="button" className="link-button fb-settings-view-all" onClick={() => onSectionChange("bank_accounts")}>
              View all accounts
            </button>
          ) : null}
        </div>

        {previewRows.length ? (
          <>
            <div className="fb-settings-accounts-table fb-settings-overview-table table-wrap">
              <table className="fb-settings-table fb-settings-overview-table-grid">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Type</th>
                    <th>Balance</th>
                    <th>Last Synced</th>
                    <th>Plaid</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row) => {
                    const meta = getOverviewRowMeta(row, expenses, plaidSyncedAt, hasPlaidConnection, beginningBalances);
                    return (
                      <tr key={meta.id}>
                        <td className="fb-settings-account-cell">
                          <div className="fb-settings-account-primary">
                            <strong>{meta.name}</strong>
                            {meta.isDefault ? <span className="fb-settings-inline-pill">Default</span> : null}
                          </div>
                          <span className="fb-settings-account-subline">{meta.subline}</span>
                        </td>
                        <td>
                          {meta.accountType ? (
                            <SettingsStatusPill tone="neutral">{meta.accountType}</SettingsStatusPill>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>{meta.balance != null ? formatUsd(meta.balance) : "—"}</td>
                        <td>{meta.lastSyncedLabel}</td>
                        <td>
                          <SettingsOverviewPlaidPill
                            status={meta.plaidStatus}
                            onConnect={() => void startPlaidLink()}
                          />
                        </td>
                        <td>
                          <div className="fb-settings-overview-actions">
                            {meta.plaidConnected ? (
                              <button
                                type="button"
                                className="fb-secondary-btn fb-settings-overview-sync"
                                disabled={syncWorking}
                                onClick={() => void syncPlaidTransactions()}
                              >
                                {syncWorking ? "…" : "Sync"}
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="fb-settings-overview-manage"
                              aria-label={`Manage ${meta.name}`}
                              onClick={() => onSectionChange("bank_accounts")}
                            >
                              Manage
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="fb-settings-overview-cards">
              {previewRows.map((row) => {
                const meta = getOverviewRowMeta(row, expenses, plaidSyncedAt, hasPlaidConnection, beginningBalances);
                return (
                  <div key={meta.id} className="fb-settings-preview-account-card">
                    <div className="fb-settings-account-card-head">
                      <div className="fb-settings-account-cell">
                        <div className="fb-settings-account-primary">
                          <h3 className="fb-settings-account-name">{meta.name}</h3>
                          {meta.isDefault ? <SettingsStatusPill tone="primary">Default</SettingsStatusPill> : null}
                        </div>
                        <span className="fb-settings-account-subline">{meta.subline}</span>
                      </div>
                      <SettingsOverviewPlaidPill
                        status={meta.plaidStatus}
                        onConnect={() => void startPlaidLink()}
                      />
                    </div>
                    <dl className="fb-settings-account-details fb-settings-preview-details">
                      <div>
                        <dt>Type</dt>
                        <dd>{meta.accountType || "—"}</dd>
                      </div>
                      <div>
                        <dt>Balance</dt>
                        <dd>{meta.balance != null ? formatUsd(meta.balance) : "—"}</dd>
                      </div>
                      <div>
                        <dt>Last synced</dt>
                        <dd>{meta.lastSyncedLabel}</dd>
                      </div>
                    </dl>
                    <div className="fb-settings-overview-actions">
                      {meta.plaidConnected ? (
                        <button
                          type="button"
                          className="fb-secondary-btn"
                          disabled={syncWorking}
                          onClick={() => void syncPlaidTransactions()}
                        >
                          {syncWorking ? "Syncing…" : "Sync"}
                        </button>
                      ) : null}
                      <button type="button" className="fb-settings-overview-manage" onClick={() => onSectionChange("bank_accounts")}>
                        Manage
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="fb-settings-overview-footer">
              {hasMore ? (
                <p className="muted fb-settings-overview-more">
                  Showing {previewRows.length} of {displayRows.length} accounts.
                </p>
              ) : null}
              <button type="button" className="fb-secondary-btn" onClick={() => onSectionChange("bank_accounts")}>
                View all accounts
              </button>
            </div>
          </>
        ) : (
          <div className="fb-settings-overview-empty">
            <p className="empty-state">No accounts connected yet.</p>
            <button type="button" className="fb-primary-btn" onClick={() => onSectionChange("bank_accounts")}>
              Add or connect accounts
            </button>
          </div>
        )}
      </section>
    );
  }

  function renderOverviewManagementCards() {
    return (
      <div className="fb-settings-mgmt-grid">
        {SETTINGS_OVERVIEW_MANAGEMENT_CARDS.map((card) => (
          <article key={card.id} className="fb-settings-mgmt-card">
            <h3 className="fb-settings-mgmt-title">{card.title}</h3>
            <p className="fb-settings-mgmt-desc">{card.description}</p>
            <button type="button" className="fb-settings-mgmt-cta" onClick={() => onSectionChange(card.id)}>
              {card.cta}
            </button>
          </article>
        ))}
      </div>
    );
  }

  function renderOverview() {
    return (
      <div className="fb-settings-overview">
        <section className="card fb-settings-panel-card fb-onboarding-callout">
          <div className="fb-onboarding-callout-body">
            <div>
              <h2 className="fb-settings-panel-title">Finish setup</h2>
              <p className="fb-settings-panel-subtitle">
                Add beginning balances and upload prior records so Firebook can learn your
                accounts and categories.
              </p>
            </div>
            <button
              type="button"
              className="fb-primary-btn"
              onClick={() => onSectionChange("onboarding")}
            >
              Start onboarding
            </button>
          </div>
        </section>
        {renderSummaryCards()}
        {renderOverviewBankAccountsPreview()}
        {renderOverviewManagementCards()}
      </div>
    );
  }

  function renderAccountRow(row: DisplayBankRow) {
    const name = row.source === "bank" ? row.bank.name : row.plaid.name;
    const institution =
      row.source === "bank" ? row.bank.institution_name || "Manual account" : `Plaid · ${row.plaid.type}`;
    const mask = row.source === "bank" ? row.bank.account_mask : row.plaid.mask;
    const isDefault = row.source === "bank" && row.bank.is_default;
    const isTwoPct = row.source === "bank" && row.bank.is_two_percent_account;
    const plaidMatch = row.source === "bank" ? row.plaid : row.plaid;
    const plaidConnected = Boolean(plaidMatch);
    const bankId = row.source === "bank" ? row.bank.id : null;
    const balance = latestBalanceForAccount(expenses, name, beginningBalances, bankId ?? undefined);
    const lastSynced = plaidConnected ? plaidSyncedAt || plaidMatch?.created_at : null;

    return (
      <div key={row.source === "bank" ? row.bank.id : row.plaid.id} className="fb-settings-account-card">
        <div className="fb-settings-account-card-head">
          <div>
            <h3 className="fb-settings-account-name">{name}</h3>
            <p className="fb-settings-account-meta">{institution}</p>
          </div>
          <div className="fb-settings-account-badges">
            {isDefault ? <SettingsStatusPill tone="primary">Default</SettingsStatusPill> : null}
            {isTwoPct ? <TwoPercentFundBadge /> : null}
            <SettingsStatusPill tone={plaidConnected ? "success" : "neutral"}>
              {plaidConnected ? "Connected" : "Not connected"}
            </SettingsStatusPill>
          </div>
        </div>
        <dl className="fb-settings-account-details">
          <div>
            <dt>Last four</dt>
            <dd>{mask ? `•••• ${mask}` : "—"}</dd>
          </div>
          <div>
            <dt>Balance</dt>
            <dd>{balance != null ? formatUsd(balance) : "—"}</dd>
          </div>
          <div>
            <dt>Last synced</dt>
            <dd>{formatSettingsDate(lastSynced)}</dd>
          </div>
        </dl>
        {bankId ? (
          <div className="fb-settings-2pct-row">
            <label className="fb-settings-checkbox">
              <input
                type="checkbox"
                checked={isTwoPct}
                onChange={(e) => void setTwoPercentAccount(bankId, e.target.checked)}
              />
              <span>
                <strong>2% Funds Account</strong>
                <span className="fb-settings-helper-text"> — Firebook will treat money here as NYS Foreign Fire Insurance / 2% funds.</span>
              </span>
            </label>
          </div>
        ) : null}
        <div className="fb-settings-account-actions">
          {plaidConnected ? (
            <button
              type="button"
              className="fb-secondary-btn"
              disabled={syncWorking}
              onClick={() => void syncPlaidTransactions()}
            >
              {syncWorking ? "Syncing…" : "Sync"}
            </button>
          ) : (
            <button type="button" className="fb-primary-btn" onClick={() => void startPlaidLink()}>
              {hasPlaidConnection ? "Reconnect Plaid" : "Connect Plaid"}
            </button>
          )}
          {bankId && !isDefault ? (
            <button type="button" className="fb-secondary-btn" onClick={() => void makeDefault(bankId)}>
              Make default
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  function renderBankAccountsSection() {
    return (
      <section className="card fb-settings-panel-card">
        <div className="fb-settings-panel-head">
          <div>
            <h2 className="fb-settings-panel-title">Connected Bank Accounts</h2>
            <p className="fb-settings-panel-subtitle">Manage and connect your department&apos;s bank accounts.</p>
          </div>
          <button type="button" className="fb-primary-btn" onClick={() => setShowAddAccount((open) => !open)}>
            {showAddAccount ? "Close" : "Add Account"}
          </button>
        </div>

        <label className="fb-settings-toggle">
          <input
            type="checkbox"
            checked={Boolean(departmentSettings?.auto_log_statement_expenses)}
            onChange={(event) => void toggleAutoLog(event.target.checked)}
          />
          <span>Automatically create missing expenses from uploaded statements</span>
        </label>

        {showAddAccount ? (
          <form className="fb-settings-add-form" onSubmit={createAccount}>
            <label>
              Account name
              <input name="name" required placeholder="Operating checking" />
            </label>
            <label>
              Institution
              <input name="institution_name" placeholder="Chase, M&T, etc." />
            </label>
            <label>
              Last 4 / mask
              <input name="account_mask" placeholder="1234" />
            </label>
            <label className="fb-settings-checkbox">
              <input type="checkbox" name="is_default" />
              <span>Set as default account</span>
            </label>
            <label className="fb-settings-checkbox">
              <input type="checkbox" name="is_two_percent_account" />
              <span>
                <strong>2% Funds Account</strong>
                <span className="fb-settings-helper-text">
                  {" "}Firebook will treat money in this account as NYS Foreign Fire Insurance / 2% funds and apply additional tracking and warnings.
                </span>
              </span>
            </label>
            <button type="submit" className="fb-primary-btn">
              Save account
            </button>
          </form>
        ) : null}

        {displayRows.length ? (
          <>
            <div className="fb-settings-accounts-table table-wrap">
              <table className="fb-settings-table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Institution</th>
                    <th>Last four</th>
                    <th>Balance</th>
                    <th>Last synced</th>
                    <th>2% Fund</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((row) => {
                    const name = row.source === "bank" ? row.bank.name : row.plaid.name;
                    const institution =
                      row.source === "bank"
                        ? row.bank.institution_name || "Manual"
                        : `Plaid · ${row.plaid.type}`;
                    const mask = row.source === "bank" ? row.bank.account_mask : row.plaid.mask;
                    const isDefault = row.source === "bank" && row.bank.is_default;
                    const isTwoPct = row.source === "bank" && row.bank.is_two_percent_account;
                    const plaidMatch = row.source === "bank" ? row.plaid : row.plaid;
                    const plaidConnected = Boolean(plaidMatch);
                    const bankId = row.source === "bank" ? row.bank.id : null;
                    const balance = latestBalanceForAccount(expenses, name, beginningBalances, bankId ?? undefined);
                    const lastSynced = plaidConnected ? plaidSyncedAt || plaidMatch?.created_at : null;
                    return (
                      <tr key={row.source === "bank" ? row.bank.id : row.plaid.id}>
                        <td>
                          <strong>{name}</strong>
                          {isDefault ? (
                            <span className="fb-settings-inline-pill">Default</span>
                          ) : null}
                          {isTwoPct ? <TwoPercentFundBadge /> : null}
                        </td>
                        <td>{institution}</td>
                        <td>{mask ? `•••• ${mask}` : "—"}</td>
                        <td>{balance != null ? formatUsd(balance) : "—"}</td>
                        <td>{formatSettingsDate(lastSynced)}</td>
                        <td>
                          {bankId ? (
                            <button
                              type="button"
                              className={`link-button fb-2pct-toggle ${isTwoPct ? "fb-2pct-toggle--on" : ""}`}
                              onClick={() => void setTwoPercentAccount(bankId, !isTwoPct)}
                              title={isTwoPct ? "Remove 2% Funds tag" : "Tag as 2% Funds account"}
                            >
                              {isTwoPct ? "✓ 2% Funds" : "Tag as 2%"}
                            </button>
                          ) : "—"}
                        </td>
                        <td>
                          <SettingsStatusPill tone={plaidConnected ? "success" : "neutral"}>
                            {plaidConnected ? "Connected" : "Not connected"}
                          </SettingsStatusPill>
                        </td>
                        <td>
                          <div className="fb-settings-row-actions">
                            {plaidConnected ? (
                              <button
                                type="button"
                                className="fb-secondary-btn"
                                disabled={syncWorking}
                                onClick={() => void syncPlaidTransactions()}
                              >
                                {syncWorking ? "Syncing…" : "Sync"}
                              </button>
                            ) : (
                              <button type="button" className="fb-secondary-btn" onClick={() => void startPlaidLink()}>
                                {hasPlaidConnection ? "Reconnect" : "Connect"}
                              </button>
                            )}
                            {bankId && !isDefault ? (
                              <button type="button" className="link-button" onClick={() => void makeDefault(bankId)}>
                                Make default
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="fb-settings-accounts-cards">{displayRows.map((row) => renderAccountRow(row))}</div>
          </>
        ) : (
          <p className="empty-state">No accounts yet. Add a manual account or connect through Plaid.</p>
        )}
      </section>
    );
  }

  function renderPlaceholderCard(
    title: string,
    subtitle: string,
    body: ReactNode,
    actions?: ReactNode,
  ) {
    return (
      <section className="card fb-settings-panel-card">
        <div className="fb-settings-panel-head">
          <div>
            <h2 className="fb-settings-panel-title">{title}</h2>
            <p className="fb-settings-panel-subtitle">{subtitle}</p>
          </div>
          {actions}
        </div>
        <div className="fb-settings-panel-body">{body}</div>
      </section>
    );
  }

  function renderSectionContent() {
    switch (activeSection) {
      case "overview":
        return renderOverview();
      case "onboarding":
        return renderOnboardingSection();
      case "bank_accounts":
        return renderBankAccountsSection();
      case "members":
        return renderPlaceholderCard(
          "Department Members",
          "Invite members and manage roles and access for your department.",
          <>
            <div className="fb-settings-dept-info">
              <p className="fb-settings-dept-name">{membership.departments?.name || "Fire Department"}</p>
              <p className="muted">Shared configuration and ledger for everyone in this department.</p>
            </div>
            <ul className="fb-settings-member-list">
              {departmentMembers.map((member) => (
                <li key={member.user_id}>
                  <span className="fb-settings-member-role">{member.role}</span>
                  <span className="muted">
                    {member.user_id === user.id ? "You" : `Member · ${member.user_id.slice(0, 8)}…`}
                  </span>
                </li>
              ))}
            </ul>
            <p className="muted">
              Invite teammates through your department signup link. Full invite management is coming soon.
            </p>
          </>,
          <button type="button" className="fb-secondary-btn" disabled>
            Invite member (soon)
          </button>,
        );
      case "categories":
        return renderPlaceholderCard(
          "Categories",
          "Create and organize categories for transactions and new expense entries.",
          <>
            {categories.length ? (
              <>
                <p>
                  <strong>{categories.length}</strong> categories in use from your expense ledger.
                  Firebook shows a 2% eligibility indicator based on the NYS 2% Fund Manual.
                </p>
                <div className="fb-settings-tag-list">
                  {categories.map((category) => {
                    const status = categoryTwoPercentStatus(category);
                    return (
                      <span key={category} className="fb-settings-tag fb-settings-tag--with-status">
                        {category}
                        {status ? (
                          <span className={`fb-2pct-cat-dot fb-2pct-cat-dot--${status}`} title={TWO_PERCENT_STATUS_LABELS[status]} />
                        ) : null}
                      </span>
                    );
                  })}
                </div>
                <div className="fb-2pct-cat-legend">
                  <span><span className="fb-2pct-cat-dot fb-2pct-cat-dot--likely_eligible" /> Likely 2% eligible</span>
                  <span><span className="fb-2pct-cat-dot fb-2pct-cat-dot--needs_review" /> Needs review</span>
                  <span><span className="fb-2pct-cat-dot fb-2pct-cat-dot--potentially_not_allowed" /> Potentially not allowed</span>
                </div>
              </>
            ) : (
              <p className="muted">Categories will appear as you log expenses with a category field.</p>
            )}
            <details className="fb-2pct-suggested-cats">
              <summary>Suggested 2% fund categories from the NYS manual</summary>
              <div className="fb-settings-tag-list" style={{ marginTop: 12 }}>
                {TWO_PERCENT_SUGGESTED_CATEGORIES.map((item) => (
                  <span key={item.name} className="fb-settings-tag fb-settings-tag--with-status">
                    {item.name}
                    <span className={`fb-2pct-cat-dot fb-2pct-cat-dot--${item.status}`} title={TWO_PERCENT_STATUS_LABELS[item.status]} />
                  </span>
                ))}
              </div>
            </details>
          </>,
          <button type="button" className="fb-secondary-btn" disabled>
            Manage categories (soon)
          </button>,
        );
      case "permissions":
        return renderPlaceholderCard(
          "Permissions & Approvals",
          "Approval rules, spending limits, and who can review or export reports.",
          <ul className="fb-settings-checklist muted">
            <li>Spending limits by role (coming soon)</li>
            <li>Expense review requirements (coming soon)</li>
            <li>Report export permissions (coming soon)</li>
          </ul>,
        );
      case "compliance": {
        const twoPctAccounts = bankAccounts.filter((a) => a.is_two_percent_account);
        const twoPctExpensesNeedingSupport = expenses.filter(
          (e) =>
            e.uses_two_percent_funds &&
            !e.support_note &&
            (!e.receipt_path ||
              e.receipt_path.includes("no-receipt") ||
              e.receipt_path.includes("/manual/")),
        ).length;
        return renderPlaceholderCard(
          "Compliance",
          "NYS 2% reporting, IRS 990 support, and audit readiness.",
          <>
            <ul className="fb-settings-checklist">
              <li className={twoPctAccounts.length > 0 ? "fb-checklist-ok" : "fb-checklist-warn"}>
                {twoPctAccounts.length > 0
                  ? `✓ ${twoPctAccounts.length} 2% Funds account${twoPctAccounts.length > 1 ? "s" : ""} tagged (${twoPctAccounts.map((a) => a.name).join(", ")})`
                  : "No 2% Funds account tagged — go to Settings → Bank Accounts to tag your NYS Foreign Fire Insurance account."}
              </li>
              <li className={twoPctExpensesNeedingSupport === 0 ? "fb-checklist-ok" : "fb-checklist-warn"}>
                {twoPctExpensesNeedingSupport === 0
                  ? "✓ All 2% transactions have receipt or support note"
                  : `${twoPctExpensesNeedingSupport} 2% transaction${twoPctExpensesNeedingSupport > 1 ? "s" : ""} missing receipt or support note`}
              </li>
              <li className="muted">NYS 2% annual report — see Tax Forms tab</li>
              <li className="muted">IRS Form 990 package — in preparation</li>
              <li className="muted">Audit trail via Transactions and Reports</li>
            </ul>
            <div style={{ marginTop: 16, borderTop: "1px solid var(--fb-border)", paddingTop: 14 }}>
              <p className="eyebrow" style={{ marginBottom: 8 }}>2% Expense Guidance</p>
              <label className="fb-settings-toggle">
                <input
                  type="checkbox"
                  checked={showTwoPercentPanel}
                  onChange={(e) => onTwoPercentPanelToggle(e.target.checked)}
                />
                <span>
                  Show 2% guidance panel while logging expenses
                  <span className="fb-settings-helper-text">
                    {" "}When on, a guidance panel appears for 2% account transactions with optional fields for member vote, meeting date, and support note.
                  </span>
                </span>
              </label>
            </div>
          </>,
        );
      }
      case "notifications":
        return renderPlaceholderCard(
          "Notifications",
          "Choose reminders for receipts, reconciliation, sync failures, and deadlines.",
          <ul className="fb-settings-checklist muted">
            <li>Missing receipt reminders (coming soon)</li>
            <li>Reconciliation reminders (coming soon)</li>
            <li>Failed bank sync alerts (coming soon)</li>
            <li>Report deadline notices (coming soon)</li>
          </ul>,
        );
      case "security":
        return renderPlaceholderCard(
          "Security",
          "Password, sessions, and access protection for your account.",
          <>
            <p>
              Signed in as <strong>{user.email}</strong> · role <strong>{membership.role}</strong>
            </p>
            <p className="muted">Password changes and active session management will be available here soon.</p>
          </>,
        );
      default:
        return null;
    }
  }

  return (
    <div className="fb-settings-page">
      <header className="card fb-settings-header fb-dash-welcome">
        <h1 className="fb-dash-title">Settings</h1>
        <p className="fb-dash-subtitle">Manage your department, accounts, users, and preferences.</p>
      </header>

      <div className="fb-settings-content">{renderSectionContent()}</div>
    </div>
  );
}

function Statements({
  membership,
  user,
  bankAccounts,
  departmentSettings,
  onExpensesChanged,
  onStatementUrlsChanged,
  statementUrls,
  showErrorMessage,
  showSuccessMessage,
}: {
  membership: DepartmentMembership;
  user: User;
  bankAccounts: BankAccount[];
  departmentSettings: DepartmentSetting | null;
  onExpensesChanged: () => Promise<void>;
  onStatementUrlsChanged: (uploads: BankStatementUpload[]) => Promise<void>;
  statementUrls: Record<string, string>;
  showErrorMessage: (message: string) => void;
  showSuccessMessage: (message: string | null) => void;
}) {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [working, setWorking] = useState(false);
  const [uploads, setUploads] = useState<BankStatementUpload[]>([]);
  const [extraction, setExtraction] = useState<BankStatementExtraction | null>(null);
  const [runStats, setRunStats] = useState<{ total: number; matched: number; flagged: number; autoLogged: number } | null>(null);
  const [bankAccountName, setBankAccountName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  useEffect(() => {
    void loadUploads();
  }, [membership.department_id]);

  function onFilesChosen(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    setSelectedFiles((prev) => [...prev, ...files]);
    event.target.value = "";
  }

  async function extractPages() {
    if (!selectedFiles.length) {
      showErrorMessage("Add at least one statement page or file.");
      return;
    }
    setWorking(true);
    try {
      const form = new FormData();
      selectedFiles.forEach((file) => form.append("statements", file));
      const response = await fetch("/api/extract-bank-statement", {
        method: "POST",
        body: form,
      });
      const payload = (await response.json()) as BankStatementExtraction;
      setExtraction(payload);
      setStartDate(payload.statement_start_date || "");
      setEndDate(payload.statement_end_date || "");
      setBankAccountName(payload.account_name || "");
    } catch (error) {
      showErrorMessage(error instanceof Error ? error.message : "Could not extract statement data.");
    } finally {
      setWorking(false);
    }
  }

  async function saveAndReconcile() {
    if (!selectedFiles.length || !extraction) {
      showErrorMessage("Upload statement pages first.");
      return;
    }
    setWorking(true);
    try {
      const savedFiles: Array<{ path: string; originalFilename: string; contentType: string }> = [];
      for (const file of selectedFiles) {
        const path = buildStatementPath({ departmentId: membership.department_id, file });
        const upload = await supabase.storage.from(bankStatementsBucket).upload(path, file, {
          contentType: file.type || "application/octet-stream",
          upsert: false,
        });
        if (upload.error) {
          throw new Error(upload.error.message);
        }
        savedFiles.push({
          path,
          originalFilename: file.name || "statement",
          contentType: file.type || "application/octet-stream",
        });
      }
      const statementUrlsPayload = await Promise.all(
        savedFiles.map(async (saved) => {
          const signed = await supabase.storage.from(bankStatementsBucket).createSignedUrl(saved.path, 60 * 15);
          return signed.data?.signedUrl || "";
        }),
      );
      const extractionResponse = await fetch("/api/extract-bank-statement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          statement_urls: statementUrlsPayload.filter(Boolean),
          filenames: savedFiles.map((saved) => saved.originalFilename),
        }),
      });
      const extracted = (await extractionResponse.json()) as BankStatementExtraction;
      if (!extracted.transactions?.length) {
        showErrorMessage(
          "No statement transactions were detected. Try uploading clearer page photos, or split the PDF into page images.",
        );
      }
      setExtraction(extracted);
      setStartDate(startDate || extracted.statement_start_date || "");
      setEndDate(endDate || extracted.statement_end_date || "");
      setBankAccountName(bankAccountName || extracted.account_name || "");
      const stats = await applyStatementReconciliation({
        membership,
        user,
        extraction: {
          ...extracted,
          statement_start_date: startDate || extracted.statement_start_date,
          statement_end_date: endDate || extracted.statement_end_date,
        },
        selectedBankAccountName: bankAccountName || extracted.account_name || "",
        statementFiles: savedFiles,
        autoLogUnmatched: Boolean(departmentSettings?.auto_log_statement_expenses),
      });
      setRunStats(stats);
      await onExpensesChanged();
      await loadUploads();
      setSelectedFiles([]);
      setExtraction(null);
      showSuccessMessage("Statement saved and reconciliation run.");
    } catch (error) {
      showErrorMessage(error instanceof Error ? error.message : "Could not save and reconcile statement.");
    } finally {
      setWorking(false);
    }
  }

  async function loadUploads() {
    const { data, error } = await supabase
      .from("bank_statement_uploads")
      .select("*")
      .eq("department_id", membership.department_id)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) return;
    const rows = (data || []) as BankStatementUpload[];
    setUploads(rows);
    await onStatementUrlsChanged(rows);
  }

  return (
    <section className="card report-card report-wide">
      <div className="section-heading">
        <p className="eyebrow">Bank statements</p>
        <h2>Upload, review, and reconcile statement pages</h2>
      </div>
      <div className="notice notice-error">
        Known bug: Some PDF statements still parse as 0 transactions. Please use multi-photo upload as a workaround while we fix parser reliability.
      </div>
      <div className="capture-options">
        <label>
          1) Take statement photos (multiple pages)
          <input type="file" accept="image/*" capture="environment" multiple onChange={onFilesChosen} />
        </label>
        <label>
          2) Upload from photos/files (images or PDF)
          <input type="file" accept="image/*,application/pdf" multiple onChange={onFilesChosen} />
        </label>
        <button type="button" disabled={working} onClick={() => void extractPages()}>
          {working ? "Extracting..." : "Review extracted statement data"}
        </button>
      </div>

      {selectedFiles.length ? (
        <div className="integration-note">
          Selected files: {selectedFiles.map((file) => file.name).join(", ")}
        </div>
      ) : null}

      {extraction ? (
        <div className="report-controls">
          <label>
            Bank account
            <select value={bankAccountName} onChange={(event) => setBankAccountName(event.target.value)}>
              <option value="">Choose account</option>
              {bankAccounts.map((account) => (
                <option key={account.id} value={account.name}>
                  {account.name}
                </option>
              ))}
            </select>
          </label>
          <TextField label="Statement start date" type="date" value={startDate} onChange={setStartDate} />
          <TextField label="Statement end date" type="date" value={endDate} onChange={setEndDate} />
          <button type="button" disabled={working} onClick={() => void saveAndReconcile()}>
            {working ? "Saving..." : "Save and reconcile"}
          </button>
        </div>
      ) : null}
      {runStats ? (
        <div className="integration-note">
          Statement transactions: {runStats.total} | matched: {runStats.matched} | flagged for review: {runStats.flagged}
          {runStats.autoLogged ? ` | auto-logged: ${runStats.autoLogged}` : ""}
        </div>
      ) : null}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Uploaded</th>
              <th>Account</th>
              <th>Period</th>
              <th>Beginning</th>
              <th>Ending</th>
              <th>File</th>
            </tr>
          </thead>
          <tbody>
            {uploads.map((upload) => (
              <tr key={upload.id}>
                <td>{upload.created_at}</td>
                <td>{upload.bank_account_name || ""}</td>
                <td>
                  {upload.statement_start_date || ""} - {upload.statement_end_date || ""}
                </td>
                <td>{upload.beginning_balance ?? ""}</td>
                <td>{upload.ending_balance ?? ""}</td>
                <td>
                  {statementUrls[upload.id] ? (
                    <a href={statementUrls[upload.id]} target="_blank" rel="noopener noreferrer">
                      View statement
                    </a>
                  ) : (
                    upload.original_filename || ""
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

async function ensureMembership(user: User) {
  const { data, error } = await supabase
    .from("department_members")
    .select("department_id,role,departments(id,name,setup_completed_at)")
    .eq("user_id", user.id)
    .limit(1);

  if (!error && data?.length) {
    return data[0] as unknown as DepartmentMembership;
  }

  const metadata = user.user_metadata || {};
  if (!metadata.pending_department_id || !metadata.pending_department_role) {
    if (error) {
      throw new Error(error.message);
    }
    return null;
  }

  const created = await createMembershipFromMetadata(user, metadata.pending_department_role, {
    id: metadata.pending_department_id as string,
    name: (metadata.pending_department_name as string) || "Fire Department",
  });
  if (!created && error) {
    throw new Error(error.message);
  }
  return created;
}

async function createMembershipFromMetadata(user: User | null, role: string, department: Department) {
  if (!user) return null;
  const normalizedRole = normalizeRole(role);
  if (!normalizedRole) return null;
  const { error } = await supabase.from("department_members").insert({
    department_id: department.id,
    user_id: user.id,
    role: normalizedRole,
  });
  if (error) {
    return null;
  }
  const { data: row } = await supabase
    .from("department_members")
    .select("department_id,role,departments(id,name,setup_completed_at)")
    .eq("user_id", user.id)
    .eq("department_id", department.id)
    .maybeSingle();
  if (!row) {
    return {
      department_id: department.id,
      role: normalizedRole,
      departments: { id: department.id, name: department.name, setup_completed_at: null },
    } satisfies DepartmentMembership;
  }
  return row as unknown as DepartmentMembership;
}

async function extractReceipt(file: File): Promise<ExtractedReceiptData> {
  const form = new FormData();
  form.append("receipt", file);
  const response = await fetch("/api/extract-receipt", {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    return { ...EMPTY_EXTRACTION, notes: "Automatic extraction failed. Review manually." };
  }
  return response.json();
}

function buildReceiptPath({
  departmentId,
  expenseId,
  receiptId,
  file,
}: {
  departmentId: string;
  expenseId: string;
  receiptId: string;
  file: File;
}) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const extension = extensionFor(file);
  return `${departmentId}/${year}/${month}/${expenseId}/${receiptId}${extension}`;
}

function extensionFor(file: File) {
  if (file.type === "image/jpeg") return ".jpg";
  if (file.type === "image/png") return ".png";
  if (file.type === "image/webp") return ".webp";
  if (file.type === "image/gif") return ".gif";
  if (file.type === "application/pdf") return ".pdf";
  const suffix = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")) : "";
  return suffix || ".bin";
}

function optionalValue(value: string) {
  const trimmed = value.trim();
  return trimmed || null;
}

function optionalNumber(value: string | number | null | undefined) {
  if (value == null) {
    return null;
  }
  const normalized = String(value).replace(/[$,]/g, "").trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function isResourceExistsError(message: string) {
  return /already exists/i.test(message);
}

function isDuplicateExpenseError(message: string) {
  return /duplicate key|already exists/i.test(message);
}

async function insertExpenseWithSchemaFallback(expensePayload: Record<string, unknown>) {
  const payload = { ...expensePayload };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await supabase.from("expenses").insert(payload);
    if (!result.error) {
      return result;
    }

    const missingColumn = missingColumnFromSchemaError(result.error.message);
    if (!missingColumn || !(missingColumn in payload)) {
      return result;
    }
    delete payload[missingColumn];
  }

  return supabase.from("expenses").insert(payload);
}

function missingColumnFromSchemaError(message: string) {
  const match = message.match(/Could not find the '([^']+)' column/i);
  return match?.[1] || null;
}

async function applyStatementReconciliation({
  membership,
  user,
  extraction,
  selectedBankAccountName,
  statementFiles,
  autoLogUnmatched,
}: {
  membership: DepartmentMembership;
  user: User;
  extraction: BankStatementExtraction;
  selectedBankAccountName: string;
  statementFiles: Array<{ path: string; originalFilename: string; contentType: string }>;
  autoLogUnmatched: boolean;
}) {
  const accountName = selectedBankAccountName || extraction.account_name || null;
  const { data: expenses, error } = await supabase
    .from("expenses")
    .select("id,transaction_date,total_amount,reconciliation_status,bank_account_name,payee,merchant_name,category")
    .eq("department_id", membership.department_id);
  if (error) throw new Error(error.message);
  const candidates = ((expenses || []) as Array<{
    id: string;
    transaction_date: string | null;
    total_amount: number | string | null;
    reconciliation_status: string;
    bank_account_name: string | null;
    payee: string | null;
    merchant_name: string | null;
    category: string | null;
  }>).filter((expense) => expense.reconciliation_status !== "matched");
  let matched = 0;
  let flagged = 0;
  let autoLogged = 0;
  const txResults: Array<{
    tx: (typeof extraction.transactions)[number];
    status: "matched" | "possible_match" | "unmatched";
    confidence: number;
    matchedExpenseId: string | null;
  }> = [];

  for (const tx of extraction.transactions || []) {
    const scored = candidates
      .map((expense) => ({ expense, score: scoreReconciliationMatch(expense, tx) }))
      .sort((a, b) => b.score - a.score);
    const top = scored[0];
    if (!top || top.score < 0.35) {
      if (autoLogUnmatched) {
        const txAmount = optionalNumber(tx.amount);
        if (txAmount != null) {
          const expenseId = crypto.randomUUID();
          const receiptId = crypto.randomUUID();
          await supabase.from("expenses").insert({
            id: expenseId,
            department_id: membership.department_id,
            receipt_id: receiptId,
            receipt_path: `${membership.department_id}/statement-import/${expenseId}/no-receipt`,
            original_filename: "statement-import",
            content_type: "text/plain",
            created_at: new Date().toISOString(),
            created_by_user_id: user.id,
            created_by_email: user.email || "",
            uploaded_by: loggedByLabel(user),
            payment_reference: tx.reference,
            payee: tx.description,
            merchant_name: tx.description,
            bank_account_name: accountName,
            transaction_date: tx.posted_date,
            total_amount: Math.abs(txAmount),
            category: null,
            extraction_status: "needs_review",
            extraction_confidence: 0,
            extraction_notes: "Auto-created from bank statement upload",
            reconciliation_status: "matched",
            bank_posted_date: tx.posted_date,
            bank_description: tx.description,
            bank_amount: txAmount,
            bank_match_confidence: 0.75,
            reconciled_at: new Date().toISOString(),
          });
          autoLogged += 1;
        }
      }
      txResults.push({ tx, status: "unmatched", confidence: 0, matchedExpenseId: null });
      continue;
    }

    const txAmount = optionalNumber(tx.amount);
    const expenseAmount = optionalNumber(top.expense.total_amount);
    const closeAmount = txAmount != null && expenseAmount != null && Math.abs(txAmount - expenseAmount) <= 0.5;

    if (top.score >= 0.8 && closeAmount) {
      await supabase
        .from("expenses")
        .update({
          reconciliation_status: "matched",
          reconciliation_candidate: false,
          reconciliation_candidate_notes: null,
          reconciliation_similarity: top.score,
          bank_posted_date: tx.posted_date,
          bank_description: tx.description,
          bank_amount: txAmount,
          bank_account_name: accountName || top.expense.bank_account_name,
          balance_after_transaction: tx.balance ?? null,
          reconciled_at: new Date().toISOString(),
        })
        .eq("id", top.expense.id);
      matched += 1;
      txResults.push({
        tx,
        status: "matched",
        confidence: top.score,
        matchedExpenseId: top.expense.id,
      });
      continue;
    }

    await supabase
      .from("expenses")
      .update({
        reconciliation_status: "needs_attention",
        reconciliation_candidate: true,
        reconciliation_similarity: top.score,
        reconciliation_candidate_notes: `Possible statement match: ${tx.description || "transaction"} ${
          txAmount == null ? "" : `($${txAmount.toFixed(2)})`
        }`,
        bank_posted_date: tx.posted_date,
        bank_description: tx.description,
        bank_amount: txAmount,
        bank_account_name: accountName || top.expense.bank_account_name,
      })
      .eq("id", top.expense.id);
    flagged += 1;
    txResults.push({
      tx,
      status: "possible_match",
      confidence: top.score,
      matchedExpenseId: top.expense.id,
    });
  }

  for (const file of statementFiles) {
    const uploadInsert = await supabase
      .from("bank_statement_uploads")
      .insert({
      department_id: membership.department_id,
      bank_account_name: accountName,
      statement_start_date: extraction.statement_start_date,
      statement_end_date: extraction.statement_end_date,
      beginning_balance: extraction.beginning_balance,
      ending_balance: extraction.ending_balance,
      statement_file_path: file.path,
      original_filename: file.originalFilename,
      content_type: file.contentType,
      uploaded_by_user_id: user.id,
      uploaded_by_email: user.email || "",
    })
      .select("id")
      .single();
    const statementUploadId = uploadInsert.data?.id;
    if (!statementUploadId) continue;
    const rows = txResults.map((result) => ({
      statement_upload_id: statementUploadId,
      department_id: membership.department_id,
      posted_date: result.tx.posted_date,
      description: result.tx.description,
      amount: optionalNumber(result.tx.amount),
      balance: optionalNumber(result.tx.balance),
      reference: result.tx.reference,
      matched_expense_id: result.matchedExpenseId,
      match_status: result.status,
      match_confidence: result.confidence,
    }));
    if (rows.length) {
      await supabase.from("bank_statement_transactions").insert(rows);
    }
  }

  return {
    total: extraction.transactions.length,
    matched,
    flagged,
    autoLogged,
  };
}

function scoreReconciliationMatch(
  expense: {
    transaction_date: string | null;
    total_amount: number | string | null;
    payee: string | null;
    merchant_name: string | null;
    category: string | null;
  },
  tx: {
    posted_date: string | null;
    description: string | null;
    amount: number | null;
  },
) {
  let score = 0;
  const txAmount = optionalNumber(tx.amount);
  const expenseAmount = optionalNumber(expense.total_amount);
  if (txAmount != null && expenseAmount != null) {
    const diff = Math.abs(Math.abs(txAmount) - Math.abs(expenseAmount));
    if (diff <= 0.5) score += 0.3;
    else if (diff <= 15) score += 0.18;
  }
  if (expense.transaction_date && tx.posted_date) {
    const days = Math.abs(new Date(expense.transaction_date).getTime() - new Date(tx.posted_date).getTime()) / 86400000;
    if (days <= 1) score += 0.3;
    else if (days <= 3) score += 0.18;
  }
  const description = normalizeMerchantText(tx.description || "");
  const vendor = normalizeMerchantText(expense.payee || expense.merchant_name || "");
  if (vendor && description.includes(vendor)) score += 0.22;
  else if (vendor && overlapScore(vendor, description) >= 0.2) score += 0.14;
  const category = (expense.category || "").toLowerCase();
  if (category && description.includes(category)) score += 0.12;
  return Math.max(0, Math.min(1, score));
}

function overlapScore(left: string, right: string) {
  const a = new Set(left.split(/[^a-z0-9]+/).filter(Boolean));
  const b = new Set(right.split(/[^a-z0-9]+/).filter(Boolean));
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const token of a) {
    if (b.has(token)) inter += 1;
  }
  return inter / Math.max(a.size, b.size);
}

function normalizeMerchantText(value: string) {
  return value
    .toLowerCase()
    .replace(/tst\*|sq\*|pp\*|uber\s*\*|doordash\s*\*/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildStatementPath({
  departmentId,
  file,
}: {
  departmentId: string;
  file: File;
}) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const safeName = (file.name || "statement").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${departmentId}/${year}/${month}/${crypto.randomUUID()}-${safeName}`;
}
