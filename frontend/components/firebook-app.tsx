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
  DepartmentSetting,
  DepartmentMembership,
  ExpenseDraft,
  ExpenseRecord,
  ExtractedReceiptData,
  ROLE_OPTIONS,
  ReviewForm,
} from "../lib/types";
import { buildReconciliationReport, reconciliationReportCsv } from "../lib/reports";

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

type ReportsDocumentsMode = "hub" | "reconciliation" | "statements";
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

function buildAccountSnapshots(bankAccounts: BankAccount[], expenses: ExpenseRecord[]): AccountSnapshot[] {
  return bankAccounts.map((account) => {
    const matches = expenses
      .filter((expense) => (expense.bank_account_name || "").trim().toLowerCase() === account.name.trim().toLowerCase())
      .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    const latest = matches[0];
    const lastBalance =
      latest && latest.balance_after_transaction != null && latest.balance_after_transaction !== ""
        ? expenseNumericAmount(latest.balance_after_transaction)
        : null;
    const lastActivityDate = latest?.transaction_date || latest?.created_at?.slice(0, 10) || null;
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

function buildVendorAggregates(expenses: ExpenseRecord[]): VendorAggregate[] {
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

function buildCategoryOptions(expenses: ExpenseRecord[]): string[] {
  const seen = new Set(PRESET_EXPENSE_CATEGORIES.map((c) => c.toLowerCase()));
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
  return [...PRESET_EXPENSE_CATEGORIES, ...historical];
}

function suggestCategoryForVendor(vendor: string, expenses: ExpenseRecord[]): string {
  const normalized = vendor.trim().toLowerCase();
  if (!normalized) return "";
  const matching = expenses.filter((expense) => {
    const label = (expense.payee || expense.merchant_name || "").trim().toLowerCase();
    return label === normalized && (expense.category || "").trim();
  });
  if (!matching.length) return "";
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

function formatBankAccountLabel(account: BankAccount): string {
  const institution = account.institution_name?.trim();
  const mask = account.account_mask?.trim();
  const meta = [institution, mask ? `•••• ${mask}` : null].filter(Boolean).join(" ");
  return meta ? `${account.name} — ${meta}` : account.name;
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
};

function VendorAutocompleteField({
  label,
  value,
  onChange,
  expenses,
  required,
  placeholder = "Start typing a vendor",
  onVendorChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  expenses: ExpenseRecord[];
  required?: boolean;
  placeholder?: string;
  onVendorChange?: (vendor: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const prevVendorRef = useRef(value.trim().toLowerCase());

  const vendorSuggestions = useMemo(() => sortVendorSuggestions(buildVendorAggregates(expenses)), [expenses]);
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

function CategoryComboboxField({
  label,
  value,
  onChange,
  expenses,
  placeholder = "Fuel, supplies, food, training...",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  expenses: ExpenseRecord[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const categoryOptions = useMemo(() => buildCategoryOptions(expenses), [expenses]);
  const filteredCategories = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return categoryOptions.slice(0, 12);
    return categoryOptions.filter((option) => option.toLowerCase().includes(q)).slice(0, 12);
  }, [value, categoryOptions]);

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
}: {
  expenses: ExpenseRecord[];
  bankAccounts: BankAccount[];
  defaultBankAccount: string;
  disabled: boolean;
  onSubmit: (values: ManualExpenseFormValues) => Promise<void>;
}) {
  const [payee, setPayee] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [category, setCategory] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [bankAccount, setBankAccount] = useState(defaultBankAccount);
  const [description, setDescription] = useState("");

  function handleVendorChange(nextVendor: string) {
    const suggestion = suggestCategoryForVendor(nextVendor, expenses);
    if (suggestion) setCategory(suggestion);
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
    });
  }

  return (
    <form className="upload-form fb-expense-form fb-new-expense-manual-form" onSubmit={handleSubmit}>
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
          required
          onVendorChange={handleVendorChange}
        />
        <CentsMoneyInput label="Amount" value={totalAmount} onChange={setTotalAmount} required />
        <PaymentMethodSelect label="Payment type" value={paymentMethod} onChange={setPaymentMethod} required />
        <CategoryComboboxField label="Category" value={category} onChange={setCategory} expenses={expenses} />
        <BankAccountSelect
          label="Bank/Credit account"
          value={bankAccount}
          onChange={setBankAccount}
          bankAccounts={bankAccounts}
          required
          emptyMessage="Add an account in Settings before logging manual expenses."
        />
      </div>
      <label>
        Description
        <textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
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
  const transactionsPanelRef = useRef<HTMLDivElement | null>(null);
  const [useCompactAppHeader, setUseCompactAppHeader] = useState(false);

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
    await loadDepartmentSettings(loadedMembership.department_id);
    await loadBankAccounts(loadedMembership.department_id);
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
            />
          ) : view === "transactions" ? (
            <div ref={transactionsPanelRef} className="fb-tab-stack">
              <ExpenseLedger
                expenses={expenses}
                receiptUrls={receiptUrls}
                user={session.user}
                onExpensesChanged={() => loadExpenses(membership.department_id)}
                showErrorMessage={showErrorMessage}
                showSuccessMessage={showSuccessMessage}
                ledgerScope={ledgerScope}
                onLedgerScopeChange={setLedgerScope}
                vendorQuery={ledgerVendorQuery}
                onVendorQueryChange={setLedgerVendorQuery}
                ledgerMayTruncate={expenses.length >= LEDGER_ALL_LIMIT}
                forceAllScope
                bankAccountFilter={ledgerBankAccountFilter}
                onClearBankAccountFilter={() => setLedgerBankAccountFilter("")}
              />
            </div>
          ) : view === "reconciliation" ? (
            <ReconciliationInboxSection
              expenses={expenses}
              receiptUrls={receiptUrls}
              onOpenFullReport={() => {
                setView("reports_documents");
                setReportsDocumentsMode("reconciliation");
                setMobileNavOpen(false);
              }}
              onOpenTransactions={() => {
                setView("transactions");
                setLedgerBankAccountFilter("");
                setMobileNavOpen(false);
              }}
            />
          ) : view === "accounts" ? (
            <AccountsTabSection
              bankAccounts={bankAccounts}
              expenses={expenses}
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
            <TaxFormsSection />
          ) : view === "vendors" ? (
            <VendorsSection expenses={expenses} />
          ) : view === "settings" ? (
            <div className="fb-tab-stack">
              <Settings
                membership={membership}
                session={session}
                bankAccounts={bankAccounts}
                departmentSettings={departmentSettings}
                onBankAccountsChanged={handleBankAccountsChanged}
                onDepartmentSettingsChanged={() => loadDepartmentSettings(membership.department_id)}
                showErrorMessage={showErrorMessage}
                showSuccessMessage={showSuccessMessage}
              />
              <section className="card fb-settings-placeholder">
                <div className="section-heading">
                  <p className="eyebrow">Department roster</p>
                  <h2>People in your department</h2>
                </div>
                <p className="muted">
                  A shared roster of treasurers and officers will appear here. For now, coordinate access with your
                  department admin outside Firebook if you need to add teammates.
                </p>
              </section>
              <section className="card fb-settings-placeholder">
                <div className="section-heading">
                  <p className="eyebrow">Profile &amp; security</p>
                  <h2>Your login and role</h2>
                </div>
                <p className="muted">
                  Editing display name, email, password, and department title will be available here. Your current role
                  is shown in the header ({membership.role}).
                </p>
              </section>
            </div>
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
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
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
    }
  }

  return (
    <form onSubmit={handleSubmit} className="upload-form">
      <label>
        Email
        <input type="email" name="email" autoComplete="email" required />
      </label>
      <label>
        Password
        <input type="password" name="password" autoComplete="current-password" required />
      </label>
      <button type="submit">Log in</button>
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

function TaxFormsSection() {
  const placeholders = [
    { title: "NYS 2% Report", desc: "Sales tax and NYS filing summaries will be generated here." },
    { title: "IRS Form 990", desc: "Nonprofit disclosure package preparation (coming soon)." },
    { title: "Year-end tax package", desc: "Exportable binder for your accountant (coming soon)." },
  ];
  return (
    <div className="fb-tab-stack">
      <section className="card fb-dash-welcome">
        <p className="eyebrow">Compliance</p>
        <h1 className="fb-dash-title">Tax Forms</h1>
        <p className="fb-dash-subtitle">
          Central place for New York and federal filings. Report generation is being prepared; nothing here changes your
          data yet.
        </p>
      </section>
      <div className="fb-doc-hub-grid">
        {placeholders.map((item) => (
          <div key={item.title} className="fb-doc-hub-card">
            <h2>{item.title}</h2>
            <p className="muted">{item.desc}</p>
            <button type="button" className="fb-secondary-btn" disabled>
              Prepare (soon)
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

type VendorSort = "recent" | "count" | "spend" | "category";

function VendorsSection({ expenses }: { expenses: ExpenseRecord[] }) {
  const [sort, setSort] = useState<VendorSort>("spend");
  const rows = useMemo(() => {
    const list = buildVendorAggregates(expenses);
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
          Vendors are derived from payee and merchant fields on logged expenses. Sorting helps treasurers see who you pay
          most often.
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
            No vendors yet. Vendors will appear automatically as you log expenses with payee or merchant names.
          </p>
        )}
      </section>
    </div>
  );
}

function AccountsTabSection({
  bankAccounts,
  expenses,
  onViewAccountTransactions,
  onBankAccountsChanged,
}: {
  bankAccounts: BankAccount[];
  expenses: ExpenseRecord[];
  onViewAccountTransactions: (accountName: string) => void;
  onBankAccountsChanged: () => Promise<void>;
}) {
  const snapshots = useMemo(() => buildAccountSnapshots(bankAccounts, expenses), [bankAccounts, expenses]);
  return (
    <div className="fb-tab-stack">
      <section className="card fb-dash-welcome">
        <p className="eyebrow">Cash & credit</p>
        <h1 className="fb-dash-title">Accounts</h1>
        <p className="fb-dash-subtitle">
          Department bank and card accounts. Balances reflect the latest register total captured on an expense when
          available.
        </p>
      </section>
      {snapshots.length ? (
        <div className="fb-account-scroll">
          {snapshots.map((snapshot) => (
            <div key={snapshot.account.id} className="fb-account-pill">
              <div className="fb-account-pill-top">
                <strong>{snapshot.account.name}</strong>
                {snapshot.account.is_default ? <span className="fb-pill">Default</span> : null}
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

function ReconciliationInboxSection({
  expenses,
  receiptUrls,
  onOpenFullReport,
  onOpenTransactions,
}: {
  expenses: ExpenseRecord[];
  receiptUrls: Record<string, string>;
  onOpenFullReport: () => void;
  onOpenTransactions: () => void;
}) {
  const actionItems = useMemo(() => expenses.filter((e) => expenseNeedsReconciliationAttention(e)), [expenses]);
  return (
    <div className="fb-tab-stack">
      <section className="card fb-dash-welcome">
        <p className="eyebrow">Action required</p>
        <h1 className="fb-dash-title">Reconciliation</h1>
        <p className="fb-dash-subtitle">
          Items below still need review or a bank match. Matched expenses are hidden here but remain in{" "}
          <strong>Transactions</strong> and in the full reconciliation report.
        </p>
      </section>
      <section className="card">
        <ReconciliationProgress expenses={expenses} />
        <div className="fb-recon-actions">
          <button type="button" className="fb-primary-btn" onClick={onOpenFullReport}>
            Open full reconciliation report
          </button>
          <button type="button" className="fb-secondary-btn" onClick={onOpenTransactions}>
            Search all transactions
          </button>
        </div>
      </section>
      <section className="card">
        <div className="section-heading">
          <p className="eyebrow">Queue</p>
          <h2>Needs attention ({actionItems.length})</h2>
        </div>
        {actionItems.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Payee</th>
                  <th>Date</th>
                  <th>Amount</th>
                  <th>Extraction</th>
                  <th>Reconcile</th>
                  <th>Receipt</th>
                </tr>
              </thead>
              <tbody>
                {actionItems.slice(0, 200).map((expense) => (
                  <tr key={expense.id}>
                    <td>{expense.payee || expense.merchant_name || "Needs review"}</td>
                    <td>{expense.transaction_date || "—"}</td>
                    <td>{expense.total_amount != null ? `$${expense.total_amount}` : "—"}</td>
                    <td>
                      <span className={`status status-${expense.extraction_status}`}>
                        {expense.extraction_status.replaceAll("_", " ")}
                      </span>
                    </td>
                    <td>
                      <span className={`status status-${expense.reconciliation_status}`}>
                        {expense.reconciliation_status.replaceAll("_", " ")}
                      </span>
                    </td>
                    <td>
                      {receiptUrls[expense.id] ? (
                        <a href={receiptUrls[expense.id]} target="_blank" rel="noopener noreferrer">
                          View
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-state">Nothing needs attention right now. Great work.</p>
        )}
      </section>
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
    setReviewForm({
      fund: nextDraft.fund,
      payment_reference: extracted.payment_reference || "",
      payee: extracted.payee || extracted.merchant_name || "",
      description: extracted.description || "",
      bank_account_name:
        extracted.bank_account_name || guessBankAccount(extracted.payee || extracted.merchant_name || ""),
      transaction_date: extracted.transaction_date || "",
      total_amount: extracted.total_amount || "",
      tax_amount: extracted.tax_amount || "",
      balance_after_transaction: extracted.balance_after_transaction || "",
      category: extracted.category || "",
      payment_method: matchPaymentMethod(extracted.payment_method || ""),
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

  const placeholders = [
    { title: "Expense report", desc: "Roll-up of expenses by period (coming soon)." },
    { title: "Vendor report", desc: "Spend concentration by vendor (coming soon)." },
    { title: "Category report", desc: "Budget lines vs actuals (coming soon)." },
    { title: "Year-end report", desc: "Annual close package (coming soon)." },
  ];

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
}) {
  function update(field: keyof ReviewForm, value: string) {
    setForm({ ...form, [field]: value });
  }

  function handleVendorChange(vendor: string) {
    const suggestion = suggestCategoryForVendor(vendor, expenses);
    if (suggestion) update("category", suggestion);
  }

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
        <div className="form-grid two-column">
          <TextField label="Date" type="date" value={form.transaction_date} onChange={(v) => update("transaction_date", v)} required />
          <TextField label="Check / payment ref" value={form.payment_reference} onChange={(v) => update("payment_reference", v)} placeholder="Check #, debit, ACH, card..." />
          <VendorAutocompleteField
            label="Paid to / vendor"
            value={form.payee}
            onChange={(v) => update("payee", v)}
            expenses={expenses}
            required
            onVendorChange={handleVendorChange}
          />
          <CentsMoneyInput label="Payment amount" value={form.total_amount} onChange={(v) => update("total_amount", v)} required />
          <CentsMoneyInput label="Tax" value={form.tax_amount} onChange={(v) => update("tax_amount", v)} />
          <TextField label="Balance after transaction" value={form.balance_after_transaction} onChange={(v) => update("balance_after_transaction", v)} />
          <BankAccountSelect
            label="Bank account"
            value={form.bank_account_name}
            onChange={(v) => update("bank_account_name", v)}
            bankAccounts={bankAccounts}
          />
          <PaymentMethodSelect label="Payment method" value={form.payment_method} onChange={(v) => update("payment_method", v)} />
          <TextField label="Fund / budget line" value={form.fund} onChange={(v) => update("fund", v)} placeholder="General, equipment, fuel..." />
          <CategoryComboboxField
            label="Category / purpose"
            value={form.category}
            onChange={(v) => update("category", v)}
            expenses={expenses}
          />
        </div>
        <label>
          Description / memo
          <textarea
            rows={3}
            value={form.description}
            onChange={(event) => update("description", event.target.value)}
          />
        </label>
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

function ExpenseLedger({
  expenses,
  receiptUrls,
  user,
  onExpensesChanged,
  showErrorMessage,
  showSuccessMessage,
  ledgerScope,
  onLedgerScopeChange,
  vendorQuery,
  onVendorQueryChange,
  ledgerMayTruncate,
  forceAllScope = false,
  bankAccountFilter = "",
  onClearBankAccountFilter,
}: {
  expenses: ExpenseRecord[];
  receiptUrls: Record<string, string>;
  user: User;
  onExpensesChanged: () => Promise<void>;
  showErrorMessage: (message: string) => void;
  showSuccessMessage: (message: string | null) => void;
  ledgerScope: LedgerScope;
  onLedgerScopeChange: (scope: LedgerScope) => void;
  vendorQuery: string;
  onVendorQueryChange: (value: string) => void;
  ledgerMayTruncate: boolean;
  forceAllScope?: boolean;
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

  const scopedExpenses = useMemo(() => {
    if (forceAllScope) return expenses;
    return ledgerScope === "recent" ? expenses.slice(0, LEDGER_RECENT_LIMIT) : expenses;
  }, [expenses, ledgerScope, forceAllScope]);

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
    let list = scopedExpenses;
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
    return list;
  }, [scopedExpenses, vendorQuery, bankAccountFilter, categoryFilter, dateFrom, dateTo, amountMin, amountMax]);

  const filteredTotal = useMemo(
    () =>
      filteredExpenses.reduce((sum, expense) => {
        const n = expenseNumericAmount(expense.total_amount);
        return sum + (n != null ? n : 0);
      }, 0),
    [filteredExpenses],
  );

  const displayExpenses = useMemo(() => {
    if (ledgerScope === "recent" && !forceAllScope) return filteredExpenses;
    const copy = [...filteredExpenses];
    copy.sort((a, b) => {
      const da = parseExpenseSortDate(a);
      const db = parseExpenseSortDate(b);
      if (da !== db) return db.localeCompare(da);
      return (b.created_at || "").localeCompare(a.created_at || "");
    });
    return copy;
  }, [filteredExpenses, ledgerScope, forceAllScope]);

  const ledgerRows = useMemo(() => {
    type Row = { kind: "quarter"; key: string; label: string } | { kind: "expense"; expense: ExpenseRecord };
    if (ledgerScope === "recent" && !forceAllScope) {
      return displayExpenses.map((expense) => ({ kind: "expense" as const, expense }));
    }
    const rows: Row[] = [];
    const buckets = new Map<string, { label: string; items: ExpenseRecord[] }>();
    for (const expense of displayExpenses) {
      const iso = parseExpenseSortDate(expense);
      const q = quarterKeyAndLabelFromISO(iso);
      const key = q?.key ?? "undated";
      const label = q?.label ?? "Undated / needs date";
      if (!buckets.has(key)) {
        buckets.set(key, { label, items: [] });
      }
      buckets.get(key)!.items.push(expense);
    }
    const keys = [...buckets.keys()].sort((a, b) => {
      if (a === "undated") return 1;
      if (b === "undated") return -1;
      return b.localeCompare(a);
    });
    for (const key of keys) {
      const bucket = buckets.get(key)!;
      rows.push({ kind: "quarter", key, label: bucket.label });
      for (const expense of bucket.items) {
        rows.push({ kind: "expense", expense });
      }
    }
    return rows;
  }, [ledgerScope, forceAllScope, displayExpenses]);

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
    onClearBankAccountFilter?.();
    setCategoryFilter("");
    setDateFrom("");
    setDateTo("");
    setAmountMin("");
    setAmountMax("");
  }

  return (
    <section className="card fb-ledger-card">
      <div className="section-heading">
        <p className="eyebrow">Expense ledger</p>
        <h2>{forceAllScope ? "All transactions" : ledgerScope === "recent" ? "Recent receipts" : "All transactions"}</h2>
        {forceAllScope ? (
          <p className="muted">
            Full department history with quarterly grouping. Use filters to refine by vendor, category, dates, or amounts.
            {bankAccountFilter.trim() ? (
              <>
                {" "}
                <button type="button" className="link-button" onClick={() => onClearBankAccountFilter?.()}>
                  Clear account filter
                </button>
              </>
            ) : null}
          </p>
        ) : ledgerScope === "recent" ? (
          <p className="muted">
            Showing the {LEDGER_RECENT_LIMIT} most recently logged expenses. Use <strong>View all</strong> for the full
            list by quarter, or search in the <strong>header</strong> to jump there with filters.
          </p>
        ) : (
          <p className="muted">
            Transactions are grouped by calendar quarter (e.g. 1/1/25–3/31/25). Refine with filters below.
          </p>
        )}
      </div>

      {!forceAllScope ? (
        <div className="ledger-toolbar">
          <div className="tab-buttons">
            <button
              type="button"
              className={ledgerScope === "recent" ? "" : "secondary-action"}
              onClick={() => onLedgerScopeChange("recent")}
            >
              Recent
            </button>
            <button
              type="button"
              className={ledgerScope === "all" ? "" : "secondary-action"}
              onClick={() => onLedgerScopeChange("all")}
            >
              View all
            </button>
          </div>
        </div>
      ) : null}
      {ledgerMayTruncate ? (
        <p className="notice">
          Showing up to {LEDGER_ALL_LIMIT.toLocaleString()} expenses. Contact support if you need a larger export.
        </p>
      ) : null}

      {ledgerScope === "all" || forceAllScope || vendorQuery || bankAccountFilter || categoryFilter || dateFrom || dateTo || amountMin || amountMax ? (
        <>
          <div className="ledger-filters">
            <label>
              Vendor / memo
              <input
                type="search"
                placeholder="e.g. Shell, Amazon"
                value={vendorQuery}
                onChange={(event) => onVendorQueryChange(event.target.value)}
                autoComplete="off"
              />
            </label>
            <label>
              Category
              <input
                type="search"
                placeholder="Fuel, supplies…"
                value={categoryFilter}
                onChange={(event) => setCategoryFilter(event.target.value)}
                autoComplete="off"
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
          <div className="ledger-presets">
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
        </>
      ) : null}

      {expenses.length ? (
        <>
          <div className="ledger-meta">
            <span>
              {ledgerScope === "recent" && !forceAllScope ? (
                <>
                  Showing {filteredExpenses.length} of {scopedExpenses.length} in recent view ({expenses.length} loaded
                  total)
                </>
              ) : (
                <>
                  Showing {filteredExpenses.length} transaction{filteredExpenses.length === 1 ? "" : "s"} (
                  {expenses.length} loaded)
                </>
              )}
            </span>
            {filteredExpenses.length > 0 ? (
              <span>
                Filtered total: <strong>${filteredTotal.toFixed(2)}</strong>
              </span>
            ) : null}
          </div>
          {filteredExpenses.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th>Payee</th>
                    <th>Logged by</th>
                    <th>Ref</th>
                    <th>Date</th>
                    <th>Total</th>
                    <th>Purpose</th>
                    <th>Extraction</th>
                    <th>Reconcile</th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerRows.map((row) =>
                    row.kind === "quarter" ? (
                      <tr key={`quarter-${row.key}`} className="ledger-quarter-row">
                        <td colSpan={9}>
                          <span className="ledger-quarter-label">{row.label}</span>
                        </td>
                      </tr>
                    ) : (
                      <tr key={row.expense.id}>
                        <td>
                          {receiptUrls[row.expense.id] ? (
                            <a
                              href={receiptUrls[row.expense.id]}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              View source
                            </a>
                          ) : (
                            <span>Receipt stored</span>
                          )}
                          <span className="filename">{row.expense.original_filename}</span>
                        </td>
                        <td>{row.expense.payee || row.expense.merchant_name || "Needs review"}</td>
                        <td>
                          <span className="filename">{formatExpenseLoggedBy(row.expense)}</span>
                        </td>
                        <td>{row.expense.payment_reference || "-"}</td>
                        <td>{row.expense.transaction_date || "Needs review"}</td>
                        <td>{row.expense.total_amount ? `$${row.expense.total_amount}` : "Needs review"}</td>
                        <td>
                          {row.expense.description || row.expense.category || "Uncategorized"}
                          {row.expense.fund && <span className="filename">{row.expense.fund}</span>}
                        </td>
                        <td>
                          <span className={`status status-${row.expense.extraction_status}`}>
                            {row.expense.extraction_status.replaceAll("_", " ")}
                          </span>
                        </td>
                        <td>
                          <span className={`status status-${row.expense.reconciliation_status}`}>
                            {row.expense.reconciliation_status.replaceAll("_", " ")}
                          </span>
                          {row.expense.reconciliation_candidate ? (
                            <span className="filename">
                              Possible match: {row.expense.reconciliation_candidate_notes || "Review manually"}
                            </span>
                          ) : null}
                          {row.expense.last_manual_edit_reason ? (
                            <span className="filename">Last edit: {row.expense.last_manual_edit_reason}</span>
                          ) : null}
                          {editingId === row.expense.id ? (
                            <div className="form-stack">
                              <input
                                placeholder="Vendor"
                                value={editValues.payee || ""}
                                onChange={(event) =>
                                  setEditValues((prev) => ({ ...prev, payee: event.target.value }))
                                }
                              />
                              <input
                                placeholder="Amount"
                                value={editValues.total_amount || ""}
                                onChange={(event) =>
                                  setEditValues((prev) => ({ ...prev, total_amount: event.target.value }))
                                }
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
                                onChange={(event) =>
                                  setEditValues((prev) => ({ ...prev, category: event.target.value }))
                                }
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
                              <div className="button-row">
                                <button type="button" onClick={() => void saveEdit(row.expense.id)}>
                                  Save edit
                                </button>
                                <button type="button" className="secondary-action" onClick={() => setEditingId(null)}>
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button type="button" className="secondary-action" onClick={() => beginEdit(row.expense)}>
                              Edit
                            </button>
                          )}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty-state">No expenses match these filters. Try clearing filters or broadening the date range.</p>
          )}
        </>
      ) : (
        <p className="empty-state">No expenses logged yet. Upload a receipt to start.</p>
      )}
    </section>
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

function Settings({
  membership,
  session,
  bankAccounts,
  departmentSettings,
  onBankAccountsChanged,
  onDepartmentSettingsChanged,
  showErrorMessage,
  showSuccessMessage,
}: {
  membership: DepartmentMembership;
  session: Session;
  bankAccounts: BankAccount[];
  departmentSettings: DepartmentSetting | null;
  onBankAccountsChanged: () => Promise<void>;
  onDepartmentSettingsChanged: () => Promise<void>;
  showErrorMessage: (message: string) => void;
  showSuccessMessage: (message: string | null) => void;
}) {
  const [plaidLinkToken, setPlaidLinkToken] = useState<string | null>(null);
  const [syncWorking, setSyncWorking] = useState(false);
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
      showSuccessMessage(`Plaid connected. Imported ${exchangePayload.accounts || 0} accounts.`);
    },
  });

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
    if (!name) return;
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
    await onBankAccountsChanged();
    if (!setupResponse.ok) {
      const payload = (await setupResponse.json()) as { error?: string };
      showErrorMessage(
        `Bank account saved, but setup status was not updated: ${payload.error || setupResponse.statusText}. Check server env (SUPABASE_SERVICE_ROLE_KEY).`,
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

  return (
    <section className="card">
      <div className="section-heading">
        <p className="eyebrow">Configuration</p>
        <h2>Bank account settings</h2>
      </div>
      <label>
        <input
          type="checkbox"
          checked={Boolean(departmentSettings?.auto_log_statement_expenses)}
          onChange={(event) => void toggleAutoLog(event.target.checked)}
        />
        Automatically create missing expenses from uploaded statements
      </label>
      <div className="button-row">
        <button type="button" onClick={() => void startPlaidLink()}>
          Connect bank/credit card with Plaid
        </button>
        <button type="button" className="secondary-action" disabled={syncWorking} onClick={() => void syncPlaidTransactions()}>
          {syncWorking ? "Syncing..." : "Sync Plaid transactions"}
        </button>
      </div>
      <form className="upload-form" onSubmit={createAccount}>
        <label>
          Account name
          <input name="name" required />
        </label>
        <label>
          Institution
          <input name="institution_name" placeholder="Chase, M&T, etc." />
        </label>
        <label>
          Last 4 / mask
          <input name="account_mask" placeholder="1234" />
        </label>
        <label>
          <input type="checkbox" name="is_default" /> Set as default account
        </label>
        <button type="submit">Save account</button>
      </form>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Institution</th>
              <th>Mask</th>
              <th>Default</th>
            </tr>
          </thead>
          <tbody>
            {bankAccounts.map((account) => (
              <tr key={account.id}>
                <td>{account.name}</td>
                <td>{account.institution_name || ""}</td>
                <td>{account.account_mask || ""}</td>
                <td>
                  {account.is_default ? (
                    "Yes"
                  ) : (
                    <button type="button" className="secondary-action" onClick={() => void makeDefault(account.id)}>
                      Make default
                    </button>
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
