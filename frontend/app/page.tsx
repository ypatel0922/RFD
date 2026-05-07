"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";

import { receiptsBucket, supabase } from "../lib/supabase";
import {
  Department,
  DepartmentMembership,
  ExpenseDraft,
  ExpenseRecord,
  ExtractedReceiptData,
  ROLE_OPTIONS,
  ReviewForm,
} from "../lib/types";
import { buildReconciliationReport, reconciliationReportCsv } from "../lib/reports";

type AuthMode = "login" | "signup";
type AppView = "dashboard" | "reports";
type MessageVariant = "success" | "error";

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

function normalizeRole(role: string) {
  const normalized = role.trim().toLowerCase();
  return ROLE_OPTIONS.find((option) => option.toLowerCase() === normalized) ?? null;
}

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [membership, setMembership] = useState<DepartmentMembership | null>(null);
  const [expenses, setExpenses] = useState<ExpenseRecord[]>([]);
  const [receiptUrls, setReceiptUrls] = useState<Record<string, string>>({});
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [view, setView] = useState<AppView>("dashboard");
  const [message, setMessage] = useState<string | null>(null);
  const [messageVariant, setMessageVariant] = useState<MessageVariant>("success");
  const [loading, setLoading] = useState(true);

  function showSuccessMessage(nextMessage: string | null) {
    setMessageVariant("success");
    setMessage(nextMessage);
  }

  function showErrorMessage(nextMessage: string) {
    setMessageVariant("error");
    setMessage(nextMessage);
  }

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
        loadMembership(nextSession.user);
      } else {
        setMembership(null);
        setExpenses([]);
        setReceiptUrls({});
      }
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  async function loadMembership(user: User) {
    const loadedMembership = await ensureMembership(user);
    setMembership(loadedMembership);
    if (loadedMembership) {
      await loadExpenses(loadedMembership.department_id);
    }
  }

  async function loadExpenses(departmentId: string) {
    const { data, error } = await supabase
      .from("expenses")
      .select("*")
      .eq("department_id", departmentId)
      .order("created_at", { ascending: false });

    if (error) {
      setMessage(error.message);
      return;
    }
    const loadedExpenses = (data || []) as ExpenseRecord[];
    setExpenses(loadedExpenses);
    await loadReceiptUrls(loadedExpenses);
  }

  async function loadReceiptUrls(loadedExpenses: ExpenseRecord[]) {
    const entries = await Promise.all(
      loadedExpenses.map(async (expense) => {
        const { data } = await supabase.storage
          .from(receiptsBucket)
          .createSignedUrl(expense.receipt_path, 60 * 60);
        return [expense.id, data?.signedUrl || ""] as const;
      }),
    );
    setReceiptUrls(
      Object.fromEntries(entries.filter((entry) => entry[1])),
    );
  }

  if (loading) {
    return <main className="auth-layout">Loading RFD Expense Tracker...</main>;
  }

  if (!session || !membership) {
    return (
      <AuthScreen
        mode={authMode}
        setMode={setAuthMode}
        onSignedIn={async (nextSession) => {
          setSession(nextSession);
          if (nextSession.user) {
            await loadMembership(nextSession.user);
          }
        }}
        message={message}
        setMessage={setMessage}
      />
    );
  }

  return (
    <>
      <header className="hero">
        <div>
          <p className="eyebrow">Fire department bookkeeping</p>
          <h1>Receipt-first expense tracking</h1>
          <p className="hero-copy">
            Capture receipts, confirm register fields, track expenses, and generate
            reconciliation reports directly from Supabase.
          </p>
        </div>
        <div className="account-panel">
          <span className="eyebrow">Signed in</span>
          <strong>{membership.departments?.name || "Fire Department"}</strong>
          <span>{session.user.email}</span>
          <span className="role">{membership.role}</span>
          <button
            className="secondary-button"
            type="button"
            onClick={() => supabase.auth.signOut()}
          >
            Log out
          </button>
        </div>
      </header>

      <main className="layout">
        <section className="card upload-card">
          <div className="section-heading">
            <p className="eyebrow">Navigation</p>
            <h2>{view === "dashboard" ? "New expense" : "Reports"}</h2>
          </div>
          <div className="tab-buttons">
            <button type="button" onClick={() => setView("dashboard")}>
              Dashboard
            </button>
            <button type="button" onClick={() => setView("reports")}>
              Reconciliation report
            </button>
          </div>
          {message && <div className={`notice ${messageVariant === "error" ? "notice-error" : ""}`}>{message}</div>}
        </section>

        {view === "dashboard" ? (
          <Dashboard
            membership={membership}
            user={session.user}
            expenses={expenses}
            receiptUrls={receiptUrls}
            onExpensesChanged={() => loadExpenses(membership.department_id)}
            setMessage={setMessage}
            showSuccessMessage={showSuccessMessage}
            showErrorMessage={showErrorMessage}
          />
        ) : (
          <Reports
            departmentName={membership.departments?.name || "Fire Department"}
            expenses={expenses}
            receiptUrls={receiptUrls}
          />
        )}
      </main>
      <footer className="app-version">App version: {APP_VERSION}</footer>
    </>
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
    <main className="auth-layout">
      <section className="card auth-card">
        <p className="eyebrow">Fire department bookkeeping</p>
        <h1>{mode === "login" ? "Log in to your department" : "Create your account"}</h1>
        <p>
          {mode === "login"
            ? "Sign in to see your department dashboard, receipts, expenses, and reports."
            : "Start typing your department, choose it from the list, then enter your email, password, and role."}
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
            className="link-button"
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
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.session) {
      setMessage(error?.message || "Could not sign in.");
      return;
    }
    await onSignedIn(data.session);
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
    const email = String(form.get("email") || "").trim();
    const password = String(form.get("password") || "");
    const role = normalizeRole(String(form.get("role") || ""));
    if (!role) {
      setMessage("Choose a valid role.");
      return;
    }
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
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
          required
        />
        <datalist id="department-options">
          {departments.map((department) => (
            <option key={department.id} value={department.name} />
          ))}
        </datalist>
      </label>
      <label>
        Email ID
        <input type="email" name="email" autoComplete="email" required />
      </label>
      <label>
        Password
        <input type="password" name="password" autoComplete="new-password" required />
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

function Dashboard({
  membership,
  user,
  expenses,
  receiptUrls,
  onExpensesChanged,
  setMessage,
  showSuccessMessage,
  showErrorMessage,
}: {
  membership: DepartmentMembership;
  user: User;
  expenses: ExpenseRecord[];
  receiptUrls: Record<string, string>;
  onExpensesChanged: () => Promise<void>;
  setMessage: (message: string | null) => void;
  showSuccessMessage: (message: string | null) => void;
  showErrorMessage: (message: string) => void;
}) {
  const [draft, setDraft] = useState<ExpenseDraft | null>(null);
  const [reviewForm, setReviewForm] = useState<ReviewForm | null>(null);
  const [showCaptureOptions, setShowCaptureOptions] = useState(false);
  const [working, setWorking] = useState(false);

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
    setShowCaptureOptions(false);
    setReviewForm({
      fund: nextDraft.fund,
      payment_reference: extracted.payment_reference || "",
      payee: extracted.payee || extracted.merchant_name || "",
      description: extracted.description || "",
      bank_account_name: extracted.bank_account_name || "",
      transaction_date: extracted.transaction_date || "",
      total_amount: extracted.total_amount || "",
      tax_amount: extracted.tax_amount || "",
      balance_after_transaction: extracted.balance_after_transaction || "",
      category: extracted.category || "",
      payment_method: extracted.payment_method || "",
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
        uploaded_by: user.email || user.id,
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

  return (
    <>
      <section className="card upload-card">
        {!draft || !reviewForm ? (
          <>
            <div className="section-heading">
              <p className="eyebrow">New expense</p>
              <h2>Log an expense</h2>
            </div>
            {!showCaptureOptions ? (
              <button type="button" disabled={working} onClick={() => setShowCaptureOptions(true)}>
                {working ? "Extracting..." : "Log an expense"}
              </button>
            ) : (
              <div className="capture-options">
                <ReceiptCaptureOption
                  title="Take a photo"
                  description="Open your camera and snap the receipt now."
                  accept="image/*"
                  capture
                  disabled={working}
                  onFileSelected={prepareReviewFromFile}
                />
                <ReceiptCaptureOption
                  title="Upload image or PDF"
                  description="Choose from camera roll, files, or desktop."
                  accept="image/*,application/pdf"
                  disabled={working}
                  onFileSelected={prepareReviewFromFile}
                />
                <button
                  type="button"
                  className="secondary-action"
                  disabled={working}
                  onClick={() => setShowCaptureOptions(false)}
                >
                  Cancel
                </button>
              </div>
            )}
            <div className="integration-note">
              Receipt fields are autofilled when extraction succeeds. You confirm the
              register fields before the expense is logged.
            </div>
          </>
        ) : (
          <ReviewExpenseForm
            draft={draft}
            form={reviewForm}
            loggedBy={user.email || user.id}
            setForm={setReviewForm}
            disabled={working}
            onSubmit={confirmExpense}
            onCancel={() => {
              setDraft(null);
              setReviewForm(null);
            }}
          />
        )}
      </section>
      <ExpenseLedger expenses={expenses} receiptUrls={receiptUrls} />
    </>
  );
}

function ReceiptCaptureOption({
  title,
  description,
  accept,
  capture,
  disabled,
  onFileSelected,
}: {
  title: string;
  description: string;
  accept: string;
  capture?: boolean;
  disabled: boolean;
  onFileSelected: (file: File) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    await onFileSelected(file);
    event.target.value = "";
  }

  return (
    <div className="capture-option">
      <div>
        <strong>{title}</strong>
        <p className="muted">{description}</p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        capture={capture ? "environment" : undefined}
        onChange={handleFileChange}
        style={{ display: "none" }}
      />
      <button type="button" disabled={disabled} onClick={() => inputRef.current?.click()}>
        {disabled ? "Extracting..." : title}
      </button>
    </div>
  );
}

function ReviewExpenseForm({
  draft,
  form,
  loggedBy,
  setForm,
  disabled,
  onSubmit,
  onCancel,
}: {
  draft: ExpenseDraft;
  form: ReviewForm;
  loggedBy: string;
  setForm: (form: ReviewForm) => void;
  disabled: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onCancel: () => void;
}) {
  function update(field: keyof ReviewForm, value: string) {
    setForm({ ...form, [field]: value });
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
      <form onSubmit={onSubmit} className="upload-form">
        <div className="form-grid two-column">
          <TextField label="Date" type="date" value={form.transaction_date} onChange={(v) => update("transaction_date", v)} required />
          <TextField label="Check / payment ref" value={form.payment_reference} onChange={(v) => update("payment_reference", v)} placeholder="Check #, debit, ACH, card..." />
          <TextField label="Paid to / vendor" value={form.payee} onChange={(v) => update("payee", v)} required />
          <TextField label="Payment amount" value={form.total_amount} onChange={(v) => update("total_amount", v)} required />
          <TextField label="Tax" value={form.tax_amount} onChange={(v) => update("tax_amount", v)} />
          <TextField label="Balance after transaction" value={form.balance_after_transaction} onChange={(v) => update("balance_after_transaction", v)} />
          <TextField label="Bank account" value={form.bank_account_name} onChange={(v) => update("bank_account_name", v)} placeholder="Checking, savings, 2% account..." />
          <TextField label="Payment method" value={form.payment_method} onChange={(v) => update("payment_method", v)} placeholder="Check, debit card, ACH..." />
          <TextField label="Fund / budget line" value={form.fund} onChange={(v) => update("fund", v)} placeholder="General, equipment, fuel..." />
          <TextField label="Category / purpose" value={form.category} onChange={(v) => update("category", v)} placeholder="Fuel, supplies, food, training..." />
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
}: {
  expenses: ExpenseRecord[];
  receiptUrls: Record<string, string>;
}) {
  return (
    <section className="card">
      <div className="section-heading">
        <p className="eyebrow">Expense ledger</p>
        <h2>Recent receipts</h2>
      </div>
      {expenses.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Receipt</th>
                <th>Payee</th>
                <th>Ref</th>
                <th>Date</th>
                <th>Total</th>
                <th>Purpose</th>
                <th>Extraction</th>
                <th>Reconcile</th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((expense) => (
                <tr key={expense.id}>
                  <td>
                    {receiptUrls[expense.id] ? (
                      <a href={receiptUrls[expense.id]} target="_blank" rel="noopener noreferrer">
                        View source
                      </a>
                    ) : (
                      <span>Receipt stored</span>
                    )}
                    <span className="filename">{expense.original_filename}</span>
                  </td>
                  <td>{expense.payee || expense.merchant_name || "Needs review"}</td>
                  <td>{expense.payment_reference || "-"}</td>
                  <td>{expense.transaction_date || "Needs review"}</td>
                  <td>{expense.total_amount ? `$${expense.total_amount}` : "Needs review"}</td>
                  <td>
                    {expense.description || expense.category || "Uncategorized"}
                    {expense.fund && <span className="filename">{expense.fund}</span>}
                  </td>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="empty-state">No expenses logged yet. Upload a receipt to start.</p>
      )}
    </section>
  );
}

function Reports({
  departmentName,
  expenses,
  receiptUrls,
}: {
  departmentName: string;
  expenses: ExpenseRecord[];
  receiptUrls: Record<string, string>;
}) {
  const [startDate, setStartDate] = useState(defaultReportStart);
  const [endDate, setEndDate] = useState(defaultReportEnd);
  const [bankAccountName, setBankAccountName] = useState("");
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

  return (
    <section className="card report-card report-wide">
      <div className="section-heading">
        <p className="eyebrow">Bank reconciliation</p>
        <h2>Reconciliation report</h2>
      </div>
      <div className="report-controls">
        <TextField label="Start date" type="date" value={startDate} onChange={setStartDate} />
        <TextField label="Period ending" type="date" value={endDate} onChange={setEndDate} />
        <TextField label="Bank account" value={bankAccountName} onChange={setBankAccountName} placeholder="Optional account filter" />
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
    </section>
  );
}

async function ensureMembership(user: User) {
  const { data, error } = await supabase
    .from("department_members")
    .select("department_id,role,departments(id,name)")
    .eq("user_id", user.id)
    .limit(1);

  if (!error && data?.length) {
    return data[0] as unknown as DepartmentMembership;
  }

  const metadata = user.user_metadata || {};
  if (!metadata.pending_department_id || !metadata.pending_department_role) {
    return null;
  }

  return createMembershipFromMetadata(user, metadata.pending_department_role, {
    id: metadata.pending_department_id,
    name: metadata.pending_department_name || "Fire Department",
  });
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
  return {
    department_id: department.id,
    role: normalizedRole,
    departments: department,
  } satisfies DepartmentMembership;
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
