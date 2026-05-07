"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";

import { bankStatementsBucket, receiptsBucket, supabase } from "../lib/supabase";
import {
  BankAccount,
  BankStatementExtraction,
  BankStatementUpload,
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
type AppView = "dashboard" | "reports" | "settings";
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
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [receiptUrls, setReceiptUrls] = useState<Record<string, string>>({});
  const [statementUrls, setStatementUrls] = useState<Record<string, string>>({});
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
        void loadMembership(nextSession.user).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Could not load your department access.";
          showErrorMessage(message);
          setMembership(null);
        });
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
    if (!loadedMembership) {
      throw new Error(
        "Your account signed in, but it is not linked to a fire department yet. Contact your admin or complete signup again.",
      );
    }
    setMembership(loadedMembership);
    await loadBankAccounts(loadedMembership.department_id);
    await loadExpenses(loadedMembership.department_id);
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
            <button type="button" onClick={() => setView("settings")}>
              Settings
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
            bankAccounts={bankAccounts}
            onExpensesChanged={() => loadExpenses(membership.department_id)}
            onBankAccountsChanged={() => loadBankAccounts(membership.department_id)}
            setMessage={setMessage}
            showSuccessMessage={showSuccessMessage}
            showErrorMessage={showErrorMessage}
          />
        ) : (
          view === "reports" ? (
          <Reports
            membership={membership}
            user={session.user}
            departmentName={membership.departments?.name || "Fire Department"}
            expenses={expenses}
            receiptUrls={receiptUrls}
            bankAccounts={bankAccounts}
            onExpensesChanged={() => loadExpenses(membership.department_id)}
            onStatementUrlsChanged={loadStatementUrls}
            statementUrls={statementUrls}
            showErrorMessage={showErrorMessage}
            showSuccessMessage={showSuccessMessage}
          />
          ) : (
            <Settings
              membership={membership}
              bankAccounts={bankAccounts}
              onBankAccountsChanged={() => loadBankAccounts(membership.department_id)}
              showErrorMessage={showErrorMessage}
              showSuccessMessage={showSuccessMessage}
            />
          )
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
  bankAccounts,
  onExpensesChanged,
  onBankAccountsChanged,
  setMessage,
  showSuccessMessage,
  showErrorMessage,
}: {
  membership: DepartmentMembership;
  user: User;
  expenses: ExpenseRecord[];
  receiptUrls: Record<string, string>;
  bankAccounts: BankAccount[];
  onExpensesChanged: () => Promise<void>;
  onBankAccountsChanged: () => Promise<void>;
  setMessage: (message: string | null) => void;
  showSuccessMessage: (message: string | null) => void;
  showErrorMessage: (message: string) => void;
}) {
  const [draft, setDraft] = useState<ExpenseDraft | null>(null);
  const [reviewForm, setReviewForm] = useState<ReviewForm | null>(null);
  const [showCaptureOptions, setShowCaptureOptions] = useState(false);
  const [working, setWorking] = useState(false);

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
    setShowCaptureOptions(false);
    setReviewForm({
      fund: nextDraft.fund,
      payment_reference: extracted.payment_reference || "",
      payee: extracted.payee || extracted.merchant_name || "",
      description: extracted.description || "",
      bank_account_name:
        extracted.bank_account_name ||
        guessBankAccount(extracted.payee || extracted.merchant_name || ""),
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
            bankAccounts={bankAccounts}
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
      <BankAccountsSummary expenses={expenses} bankAccounts={bankAccounts} onBankAccountsChanged={onBankAccountsChanged} />
      <ExpenseLedger
        expenses={expenses}
        receiptUrls={receiptUrls}
        user={user}
        onExpensesChanged={onExpensesChanged}
        showErrorMessage={showErrorMessage}
        showSuccessMessage={showSuccessMessage}
      />
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
  bankAccounts,
  loggedBy,
  setForm,
  disabled,
  onSubmit,
  onCancel,
}: {
  draft: ExpenseDraft;
  form: ReviewForm;
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
          <label>
            Bank account
            <select value={form.bank_account_name} onChange={(event) => update("bank_account_name", event.target.value)}>
              <option value="">Choose account</option>
              {bankAccounts.map((account) => (
                <option key={account.id} value={account.name}>
                  {account.name}
                  {account.is_default ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
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
  user,
  onExpensesChanged,
  showErrorMessage,
  showSuccessMessage,
}: {
  expenses: ExpenseRecord[];
  receiptUrls: Record<string, string>;
  user: User;
  onExpensesChanged: () => Promise<void>;
  showErrorMessage: (message: string) => void;
  showSuccessMessage: (message: string | null) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editReason, setEditReason] = useState("");
  const [editValues, setEditValues] = useState<Record<string, string>>({});

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
                    {expense.reconciliation_candidate ? (
                      <span className="filename">
                        Possible match: {expense.reconciliation_candidate_notes || "Review manually"}
                      </span>
                    ) : null}
                    {expense.last_manual_edit_reason ? (
                      <span className="filename">
                        Last edit: {expense.last_manual_edit_reason}
                      </span>
                    ) : null}
                    {editingId === expense.id ? (
                      <div className="form-stack">
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
                          onChange={(event) => setEditValues((prev) => ({ ...prev, transaction_date: event.target.value }))}
                        />
                        <input
                          placeholder="Category"
                          value={editValues.category || ""}
                          onChange={(event) => setEditValues((prev) => ({ ...prev, category: event.target.value }))}
                        />
                        <input
                          placeholder="Bank account"
                          value={editValues.bank_account_name || ""}
                          onChange={(event) => setEditValues((prev) => ({ ...prev, bank_account_name: event.target.value }))}
                        />
                        <textarea
                          rows={2}
                          placeholder="Reason for edit (required)"
                          value={editReason}
                          onChange={(event) => setEditReason(event.target.value)}
                        />
                        <div className="button-row">
                          <button type="button" onClick={() => void saveEdit(expense.id)}>Save edit</button>
                          <button type="button" className="secondary-action" onClick={() => setEditingId(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <button type="button" className="secondary-action" onClick={() => beginEdit(expense)}>
                        Edit
                      </button>
                    )}
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
    <section className="card">
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
        statementFilePath: statementPath,
        originalFilename: file.name || "statement",
        contentType: file.type || "application/octet-stream",
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
  bankAccounts,
  onBankAccountsChanged,
  showErrorMessage,
  showSuccessMessage,
}: {
  membership: DepartmentMembership;
  bankAccounts: BankAccount[];
  onBankAccountsChanged: () => Promise<void>;
  showErrorMessage: (message: string) => void;
  showSuccessMessage: (message: string | null) => void;
}) {
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
    formElement.reset();
    await onBankAccountsChanged();
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

  return (
    <section className="card">
      <div className="section-heading">
        <p className="eyebrow">Configuration</p>
        <h2>Bank account settings</h2>
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
    if (error) {
      throw new Error(error.message);
    }
    return null;
  }

  const created = await createMembershipFromMetadata(user, metadata.pending_department_role, {
    id: metadata.pending_department_id,
    name: metadata.pending_department_name || "Fire Department",
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

async function applyStatementReconciliation({
  membership,
  user,
  extraction,
  selectedBankAccountName,
  statementFilePath,
  originalFilename,
  contentType,
}: {
  membership: DepartmentMembership;
  user: User;
  extraction: BankStatementExtraction;
  selectedBankAccountName: string;
  statementFilePath: string;
  originalFilename: string;
  contentType: string;
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

  for (const tx of extraction.transactions || []) {
    const scored = candidates
      .map((expense) => ({ expense, score: scoreReconciliationMatch(expense, tx) }))
      .sort((a, b) => b.score - a.score);
    const top = scored[0];
    if (!top || top.score < 0.45) continue;

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
  }

  await supabase.from("bank_statement_uploads").insert({
    department_id: membership.department_id,
    bank_account_name: accountName,
    statement_start_date: extraction.statement_start_date,
    statement_end_date: extraction.statement_end_date,
    beginning_balance: extraction.beginning_balance,
    ending_balance: extraction.ending_balance,
    statement_file_path: statementFilePath,
    original_filename: originalFilename,
    content_type: contentType,
    uploaded_by_user_id: user.id,
    uploaded_by_email: user.email || "",
  });
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
