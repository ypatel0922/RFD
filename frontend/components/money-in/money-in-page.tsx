"use client";

import {
  ChangeEvent,
  DragEvent,
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { User } from "@supabase/supabase-js";

import { logAuditFromBrowser } from "../../lib/audit";
import { normalizeVendorKey } from "../../lib/category-suggestion";
import {
  buildMoneyInCategoryOptions,
  isTwoPercentIncomeCategory,
  isTypedMoneyInRow,
  moneyInCategoryConfig,
} from "../../lib/money-in/categories";
import { buildSourceHistory } from "../../lib/money-in/history";
import {
  ensureCounterparty,
  extractMoneyInDocument,
  insertLedgerRows,
  linkExternalTransaction,
  loadCounterparties,
} from "../../lib/money-in/persist";
import {
  buildMoneyInDocumentPath,
  buildMoneyInLedgerRow,
  buildTransferLedgerRows,
  defaultDepositStatus,
  emptyMoneyInForm,
  MONEY_IN_PAYMENT_METHODS,
  validateMoneyIn,
  type MoneyInFormValues,
  type MoneyInMode,
  type MoneyInValidationError,
} from "../../lib/money-in/record";
import {
  isBadgedSuggestion,
  isMoneyInHistoryRow,
  suggestMoneyInCategory,
  suggestMoneyInTwoPercent,
  type MoneyInCategorySuggestion,
  type MoneyInTwoPercentSuggestion,
} from "../../lib/money-in/suggestion";
import { shouldApplyExtractionResult } from "../../lib/category-suggestion";
import { parseCents } from "../../lib/reconciliation/money";
import { receiptsBucket, supabase } from "../../lib/supabase";
import { moneyToCents } from "../../lib/tip";
import type {
  BankAccount,
  DepartmentCategory,
  DepartmentCounterparty,
  DepartmentMembership,
  ExpenseRecord,
  ExtractedMoneyInData,
} from "../../lib/types";

/** Starting values when Money In is opened from a bank credit or statement line. */
export type MoneyInPrefill = {
  mode?: MoneyInMode;
  date?: string;
  payer?: string;
  amountCents?: number;
  depositAccount?: string;
  transferFromAccount?: string;
  memo?: string;
  checkNumber?: string;
  /** The bank row this record will be linked to, so the deposit counts once. */
  bank?: {
    externalRowId: string;
    externalTransactionId: string;
    postedDate: string | null;
    description: string | null;
    amountCents: number;
  };
};

export type MoneyInLaunch = { tab: "document" | "manual"; prefill?: MoneyInPrefill } | null;

type DocumentDraft = {
  id: string;
  documentId: string;
  file: File;
  previewUrl: string | null;
  path: string;
  extracted: ExtractedMoneyInData;
};

type EditField = MoneyInValidationError["field"] | null;

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatUsdCents(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function formatDisplayDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`;
}

function formatFriendlyDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function loggedByLabel(user: User) {
  const name = user.user_metadata?.full_name != null ? String(user.user_metadata.full_name).trim() : "";
  const email = user.email || "";
  if (name && email) return `${name} (${email})`;
  return email || user.id;
}

function extensionFor(file: File) {
  if (file.type === "image/jpeg") return ".jpg";
  if (file.type === "image/png") return ".png";
  if (file.type === "image/webp") return ".webp";
  if (file.type === "image/heic") return ".heic";
  if (file.type === "application/pdf") return ".pdf";
  const suffix = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")) : "";
  return suffix || ".bin";
}

function accountMeta(account: BankAccount | undefined): string {
  if (!account) return "";
  return [account.institution_name?.trim() || null, account.account_mask?.trim() ? `•••• ${account.account_mask.trim()}` : null]
    .filter(Boolean)
    .join(" ");
}

function sameName(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

async function withTimeout<T>(promise: PromiseLike<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function useDismissOnOutsideClick(ref: { current: HTMLElement | null }, onDismiss: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    function handle(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onDismiss();
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [active, onDismiss, ref]);
}

type IconKind = "date" | "source" | "amount" | "account" | "category" | "two_percent" | "transfer";

function MoneyInIcon({ kind }: { kind: IconKind }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };
  switch (kind) {
    case "date":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      );
    case "source":
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21a8 8 0 0 1 16 0" />
        </svg>
      );
    case "amount":
      return (
        <svg {...common}>
          <line x1="12" y1="1" x2="12" y2="23" />
          <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
        </svg>
      );
    case "account":
      return (
        <svg {...common}>
          <path d="M3 21h18" />
          <path d="M3 10h18" />
          <path d="M5 6l7-3 7 3" />
          <path d="M6 10v11M10 10v11M14 10v11M18 10v11" />
        </svg>
      );
    case "category":
      return (
        <svg {...common}>
          <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
          <line x1="7" y1="7" x2="7.01" y2="7" />
        </svg>
      );
    case "transfer":
      return (
        <svg {...common}>
          <path d="M7 7h13l-3-3M17 17H4l3 3" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <line x1="19" y1="5" x2="5" y2="19" />
          <circle cx="6.5" cy="6.5" r="2.5" />
          <circle cx="17.5" cy="17.5" r="2.5" />
        </svg>
      );
  }
}

function MoneyInput({
  label,
  cents,
  onChange,
  required,
}: {
  label: string;
  cents: number;
  onChange: (cents: number) => void;
  required?: boolean;
}) {
  return (
    <label>
      {label}
      <input
        inputMode="numeric"
        autoComplete="off"
        value={cents > 0 ? formatUsdCents(cents) : ""}
        onChange={(event) => {
          const digits = event.target.value.replace(/\D/g, "").slice(0, 11);
          onChange(digits ? Number.parseInt(digits, 10) : 0);
        }}
        required={required}
        placeholder="$0.00"
      />
    </label>
  );
}

function AccountSelect({
  label,
  value,
  onChange,
  bankAccounts,
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  bankAccounts: BankAccount[];
  required?: boolean;
}) {
  if (!bankAccounts.length) {
    return (
      <label>
        {label}
        <p className="fb-field-hint">Add an account in Settings to choose where money is deposited.</p>
      </label>
    );
  }
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)} required={required}>
        <option value="">Choose account</option>
        {bankAccounts.map((account) => {
          const meta = accountMeta(account);
          return (
            <option key={account.id} value={account.name}>
              {meta ? `${account.name} — ${meta}` : account.name}
              {account.is_default ? " (default)" : ""}
              {account.is_two_percent_account ? " · 2% Funds" : ""}
            </option>
          );
        })}
      </select>
    </label>
  );
}

/** One review row: a tap-to-edit summary in document review, an always-open editor in manual entry. */
function FieldRow({
  icon,
  label,
  display,
  empty,
  sub,
  chip,
  editing,
  inline,
  onEdit,
  rowRef,
  children,
}: {
  icon: IconKind;
  label: string;
  display: string;
  empty: string;
  sub?: ReactNode;
  chip?: ReactNode;
  editing: boolean;
  inline: boolean;
  onEdit: () => void;
  rowRef?: { current: HTMLDivElement | null };
  children: ReactNode;
}) {
  const open = !inline || editing;
  return (
    <div className={`fb-detail-row${open && inline ? " fb-detail-row--editing" : ""}`} ref={editing ? rowRef : undefined}>
      <span className="fb-detail-icon">
        <MoneyInIcon kind={icon} />
      </span>
      {open ? (
        <div className="fb-detail-editor">
          {children}
          {sub && !inline ? <span className="fb-detail-sub">{sub}</span> : null}
        </div>
      ) : (
        <button type="button" className="fb-detail-hit" onClick={onEdit}>
          <span className="fb-detail-label">{label}</span>
          <span className={`fb-detail-value${!display ? " fb-detail-value--empty" : ""}`}>{display || empty}</span>
          {chip}
          {sub ? <span className="fb-detail-sub">{sub}</span> : null}
        </button>
      )}
    </div>
  );
}

function DocumentUpload({
  isMobileDevice,
  busy,
  onFileSelected,
}: {
  isMobileDevice: boolean;
  busy: boolean;
  onFileSelected: (file: File) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  async function take(file: File | undefined | null) {
    if (!file || busy) return;
    await onFileSelected(file);
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!busy) setDragOver(true);
  }

  return (
    <div
      className={`fb-receipt-dropzone${dragOver ? " fb-drag-over" : ""}${busy ? " fb-receipt-dropzone--busy" : ""}`}
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={(event) => {
        event.preventDefault();
        const next = event.relatedTarget as Node | null;
        if (next && event.currentTarget.contains(next)) return;
        setDragOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setDragOver(false);
        void take(event.dataTransfer.files?.[0]);
      }}
    >
      <div className="fb-receipt-dropzone-icon fb-money-in-dropzone-icon" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="6" width="20" height="12" rx="2" />
          <path d="M6 14h5M15 10h3" />
          <path d="M12 2v6M9 5l3 3 3-3" />
        </svg>
      </div>
      {busy ? (
        <div className="fb-receipt-dropzone-status" role="status" aria-live="polite">
          <span className="fb-receipt-spinner" aria-hidden="true" />
          <h2 className="fb-receipt-dropzone-title">Reading document…</h2>
          <p className="fb-receipt-dropzone-copy">Hallix is extracting the payment details.</p>
        </div>
      ) : (
        <>
          <h2 className="fb-receipt-dropzone-title">Upload a check or document</h2>
          <p className="fb-receipt-dropzone-copy">
            {isMobileDevice ? "Take a photo or choose a file." : "Drag & drop or choose a file."}
          </p>
          <input
            ref={inputRef}
            type="file"
            accept="image/*,application/pdf"
            className="fb-visually-hidden"
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              void take(file);
            }}
            aria-label="Choose check or document file"
          />
          <button type="button" className="fb-primary-btn fb-receipt-choose-btn" onClick={() => inputRef.current?.click()}>
            Choose file
          </button>
          <p className="fb-receipt-dropzone-formats">JPG, PNG or PDF</p>
          <p className="fb-receipt-dropzone-note">Hallix will extract the payment details for you to review.</p>
        </>
      )}
    </div>
  );
}

export function MoneyInPage({
  membership,
  user,
  accessToken,
  expenses,
  bankAccounts,
  departmentCategories = [],
  launch,
  onLaunchConsumed,
  onRecorded,
  showSuccessMessage,
  showErrorMessage,
}: {
  membership: DepartmentMembership;
  user: User;
  accessToken: string;
  expenses: ExpenseRecord[];
  bankAccounts: BankAccount[];
  departmentCategories?: DepartmentCategory[];
  launch: MoneyInLaunch;
  onLaunchConsumed: () => void;
  onRecorded: () => Promise<void>;
  showSuccessMessage: (message: string | null) => void;
  showErrorMessage: (message: string) => void;
}) {
  const departmentId = membership.department_id;
  const defaultAccount = bankAccounts.find((a) => a.is_default)?.name || (bankAccounts.length === 1 ? bankAccounts[0].name : "");
  const [entryTab, setEntryTab] = useState<"document" | "manual">("document");
  const [draft, setDraft] = useState<DocumentDraft | null>(null);
  const [form, setForm] = useState<MoneyInFormValues | null>(null);
  const [prefill, setPrefill] = useState<MoneyInPrefill | undefined>(undefined);
  const [working, setWorking] = useState(false);
  const [categorySuggestion, setCategorySuggestion] = useState<MoneyInCategorySuggestion | null>(null);
  const [twoPctSuggestion, setTwoPctSuggestion] = useState<MoneyInTwoPercentSuggestion | null>(null);
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [counterparties, setCounterparties] = useState<DepartmentCounterparty[]>([]);
  const [isMobileDevice, setIsMobileDevice] = useState(false);
  const extractionRequestRef = useRef(0);

  const allowedCategories = useMemo(
    () => buildMoneyInCategoryOptions(departmentCategories, expenses, departmentId),
    [departmentCategories, expenses, departmentId],
  );

  useEffect(() => {
    let cancelled = false;
    void loadCounterparties(departmentId).then((rows) => {
      if (!cancelled) setCounterparties(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [departmentId]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const coarse = window.matchMedia("(pointer: coarse)");
    const sync = () => setIsMobileDevice(coarse.matches);
    sync();
    coarse.addEventListener("change", sync);
    return () => coarse.removeEventListener("change", sync);
  }, []);

  const manualDefaults = useCallback(
    (next?: MoneyInPrefill): MoneyInFormValues =>
      emptyMoneyInForm({
        mode: next?.mode ?? "money_in",
        date_received: next?.date || todayIso(),
        payer: next?.payer || "",
        amount_cents: next?.amountCents ?? 0,
        deposit_account: next?.depositAccount || defaultAccount,
        transfer_from_account: next?.transferFromAccount || "",
        memo: next?.memo || "",
        check_number: next?.checkNumber || "",
        deposit_status: "deposited",
        deposit_date: next?.bank?.postedDate || "",
      }),
    [defaultAccount],
  );

  function resetSuggestions() {
    extractionRequestRef.current += 1;
    setCategorySuggestion(null);
    setTwoPctSuggestion(null);
    setCategoryTouched(false);
  }

  function computeSuggestions(values: MoneyInFormValues, extracted?: ExtractedMoneyInData | null, plaidText?: string | null) {
    const depositAcct = bankAccounts.find((a) => sameName(a.name, values.deposit_account));
    let category: MoneyInCategorySuggestion | null = null;
    try {
      category = suggestMoneyInCategory({
        payer: values.payer,
        memo: values.memo,
        documentText: [extracted?.fund_designation, extracted?.grant_reference ? `grant ${extracted.grant_reference}` : null]
          .filter(Boolean)
          .join(" "),
        plaidDescription: plaidText,
        aiCategory: extracted?.suggested_category,
        aiConfidence: extracted?.category_confidence,
        allowedCategories,
        ledgerRows: expenses,
        departmentId,
        counterparties,
      });
    } catch {
      category = null;
    }
    let twoPct: MoneyInTwoPercentSuggestion | null = null;
    try {
      twoPct = suggestMoneyInTwoPercent({
        payer: values.payer,
        memo: values.memo,
        documentText: extracted?.fund_designation,
        plaidDescription: plaidText,
        category: category?.category,
        ledgerRows: expenses,
        departmentId,
        departmentCategories,
        aiSuggestsTwoPercent: extracted?.suggest_two_percent,
        aiConfidence: extracted?.two_percent_confidence,
        depositAccountIsTwoPercent: Boolean(depositAcct?.is_two_percent_account),
        alreadyTwoPercent: values.uses_two_percent_funds,
      });
    } catch {
      twoPct = null;
    }
    return { category, twoPct };
  }

  function startManual(next?: MoneyInPrefill) {
    resetSuggestions();
    setDraft(null);
    setPrefill(next);
    const values = manualDefaults(next);
    if (next?.payer || next?.memo || next?.bank) {
      const { category, twoPct } = computeSuggestions(values, null, next?.bank?.description ?? next?.memo);
      if (category) values.category = category.category;
      setCategorySuggestion(category);
      setTwoPctSuggestion(twoPct);
    }
    setForm(values);
  }

  useEffect(() => {
    if (!launch) return;
    setEntryTab(launch.tab);
    if (launch.tab === "manual" || launch.prefill) {
      // A bank or statement prefill is always reviewed in the manual form.
      setEntryTab("manual");
      startManual(launch.prefill);
    } else {
      resetSuggestions();
      setDraft(null);
      setForm(null);
      setPrefill(undefined);
    }
    onLaunchConsumed();
    // startManual reads current props; it only needs to run when a new launch arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launch, onLaunchConsumed]);

  function selectEntryTab(next: "document" | "manual") {
    if (next === entryTab) return;
    setEntryTab(next);
    if (next === "manual") {
      startManual();
    } else {
      resetSuggestions();
      setDraft(null);
      setForm(null);
      setPrefill(undefined);
    }
  }

  async function readDocument(file: File) {
    setWorking(true);
    resetSuggestions();
    const requestId = extractionRequestRef.current + 1;
    extractionRequestRef.current = requestId;
    const id = crypto.randomUUID();
    const documentId = crypto.randomUUID();
    // Extraction failures come back as an empty, review-able result.
    const extracted = await extractMoneyInDocument({ file, departmentId, accessToken, allowedCategories });
    if (!shouldApplyExtractionResult(requestId, extractionRequestRef.current)) return;

    const paymentMethod = extracted.payment_method || (extracted.document_type === "check" ? "check" : "");
    const values = emptyMoneyInForm({
      date_received: extracted.date || todayIso(),
      payer: extracted.payer || "",
      amount_cents: moneyToCents(extracted.amount) ?? 0,
      deposit_account: defaultAccount,
      check_number: extracted.check_number || "",
      memo: extracted.memo || "",
      fund: extracted.fund_designation || "",
      grant_reference: extracted.grant_reference || "",
      payment_method: paymentMethod,
      deposit_status: defaultDepositStatus(paymentMethod, extracted.document_type),
    });
    const { category, twoPct } = computeSuggestions(values, extracted);
    if (category) values.category = category.category;
    setCategorySuggestion(category);
    setTwoPctSuggestion(twoPct);
    setDraft({
      id,
      documentId,
      file,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      path: buildMoneyInDocumentPath({ departmentId, expenseId: id, documentId, extension: extensionFor(file) }),
      extracted,
    });
    setForm(values);
    setWorking(false);
  }

  function updateForm(next: MoneyInFormValues, changed: keyof MoneyInFormValues) {
    if (changed === "category") setCategoryTouched(true);
    setForm(next);
  }

  /** A new payer re-runs suggestions, but never over a category the user chose. */
  function onPayerCommitted(values: MoneyInFormValues) {
    const { category, twoPct } = computeSuggestions(values, draft?.extracted, prefill?.bank?.description);
    setTwoPctSuggestion(twoPct);
    if (categoryTouched) return;
    setCategorySuggestion(category);
    if (category) setForm({ ...values, category: category.category });
  }

  function cancel() {
    resetSuggestions();
    if (entryTab === "manual") {
      startManual();
      return;
    }
    setDraft(null);
    setForm(null);
    setPrefill(undefined);
  }

  async function record(values: MoneyInFormValues): Promise<MoneyInValidationError | null> {
    const invalid = validateMoneyIn(values, { hasBankAccounts: bankAccounts.length > 0 });
    if (invalid) {
      showErrorMessage(invalid.message);
      return invalid;
    }
    setWorking(true);
    const actor = { id: user.id, email: user.email || "", label: loggedByLabel(user) };
    try {
      if (values.mode === "transfer") {
        const groupId = crypto.randomUUID();
        const [outLeg, inLeg] = buildTransferLedgerRows({
          outId: crypto.randomUUID(),
          inId: crypto.randomUUID(),
          groupId,
          departmentId,
          values,
          actor,
          bankLegs: prefill?.bank
            ? {
                in: {
                  externalTransactionId: prefill.bank.externalTransactionId,
                  postedDate: prefill.bank.postedDate,
                  description: prefill.bank.description,
                  amountCents: prefill.bank.amountCents,
                },
              }
            : undefined,
        });
        const insert = await withTimeout(insertLedgerRows([outLeg, inLeg]), 30000, "Saving the transfer timed out.");
        if (insert.error) {
          showErrorMessage(insert.error.message);
          return null;
        }
        if (prefill?.bank) {
          await linkExternalTransaction({ departmentId, externalRowId: prefill.bank.externalRowId, expenseId: String(inLeg.id) });
        }
        void logAuditFromBrowser({
          departmentId,
          userRole: membership.role,
          action: "transfer.recorded",
          resourceType: "expense",
          resourceId: String(inLeg.id),
          resourceLabel: `${values.transfer_from_account} → ${values.deposit_account}`,
          afterData: { amount_cents: values.amount_cents, date: values.date_received, transfer_group_id: groupId },
          metadata: { flow: "money_in", source: prefill?.bank ? "bank_feed" : "manual" },
        });
        showSuccessMessage("Transfer recorded. It changes account balances only and is not counted as income.");
      } else {
        const id = draft?.id ?? crypto.randomUUID();
        if (draft) {
          const upload = await withTimeout(
            supabase.storage.from(receiptsBucket).upload(draft.path, draft.file, {
              contentType: draft.file.type || "application/octet-stream",
              upsert: false,
            }),
            30000,
            "Uploading the document timed out. Check your connection and try again.",
          );
          if (upload.error && !/already exists/i.test(upload.error.message)) {
            showErrorMessage(upload.error.message);
            return null;
          }
        }
        const counterpartyId = await ensureCounterparty({
          departmentId,
          name: values.payer,
          category: values.category,
          existing: counterparties,
        });
        const row = buildMoneyInLedgerRow({
          id,
          departmentId,
          values,
          actor,
          document: draft
            ? {
                receiptId: draft.documentId,
                path: draft.path,
                filename: draft.file.name || "document",
                contentType: draft.file.type || "application/octet-stream",
                documentType: draft.extracted.document_type,
              }
            : null,
          extraction: draft?.extracted ?? null,
          counterpartyId,
          suggestion: {
            suggestedCategory: categorySuggestion?.category ?? null,
            suggestedCategorySource: categorySuggestion?.source ?? null,
            twoPercentSuggested: Boolean(twoPctSuggestion),
          },
          bankMatch: prefill?.bank
            ? {
                externalTransactionId: prefill.bank.externalTransactionId,
                postedDate: prefill.bank.postedDate,
                description: prefill.bank.description,
                amountCents: prefill.bank.amountCents,
              }
            : null,
        });
        const insert = await withTimeout(insertLedgerRows([row]), 30000, "Saving timed out. Please try again.");
        if (insert.error && !/duplicate key|already exists/i.test(insert.error.message)) {
          showErrorMessage(insert.error.message);
          return null;
        }
        if (prefill?.bank) {
          await linkExternalTransaction({ departmentId, externalRowId: prefill.bank.externalRowId, expenseId: id });
        }
        const snapshot = {
          payer: values.payer,
          amount_cents: values.amount_cents,
          date_received: values.date_received,
          category: values.category,
          transaction_type: row.transaction_type,
          deposit_account: values.deposit_account,
          deposit_status: row.deposit_status,
          two_percent: row.uses_two_percent_funds,
        };
        void logAuditFromBrowser({
          departmentId,
          userRole: membership.role,
          action: "money_in.recorded",
          resourceType: "expense",
          resourceId: id,
          resourceLabel: values.payer,
          afterData: snapshot,
          metadata: {
            source: prefill?.bank ? "bank_feed" : draft ? "document" : "manual",
            suggested_category: categorySuggestion?.category ?? null,
            suggested_category_source: categorySuggestion?.source ?? null,
            category_overridden: categorySuggestion ? !sameName(categorySuggestion.category, values.category) : null,
            counterparty_id: counterpartyId,
          },
        });
        if (draft) {
          void logAuditFromBrowser({
            departmentId,
            userRole: membership.role,
            action: "money_in.document_uploaded",
            resourceType: "expense",
            resourceId: id,
            resourceLabel: values.payer,
            metadata: { document_type: draft.extracted.document_type, content_type: draft.file.type },
          });
        }
        if (row.uses_two_percent_funds) {
          void logAuditFromBrowser({
            departmentId,
            userRole: membership.role,
            action: "money_in.two_percent_confirmed",
            resourceType: "expense",
            resourceId: id,
            resourceLabel: values.payer,
            metadata: { suggested: Boolean(twoPctSuggestion) },
          });
        }
        if (prefill?.bank) {
          void logAuditFromBrowser({
            departmentId,
            userRole: membership.role,
            action: "money_in.bank_matched",
            resourceType: "expense",
            resourceId: id,
            resourceLabel: values.payer,
            metadata: { external_transaction_id: prefill.bank.externalRowId },
          });
        }
        showSuccessMessage(
          row.transaction_type === "refund"
            ? "Refund recorded. It reduces spending and is not counted as income."
            : "Money in recorded.",
        );
      }

      void onRecorded().catch(() => undefined);
      void loadCounterparties(departmentId).then(setCounterparties);
      resetSuggestions();
      setPrefill(undefined);
      setDraft(null);
      setForm(entryTab === "manual" ? manualDefaults() : null);
      return null;
    } catch (error) {
      showErrorMessage(error instanceof Error ? error.message : "Could not record money in.");
      return null;
    } finally {
      setWorking(false);
    }
  }

  const showReview = Boolean(form) && (entryTab === "manual" || Boolean(draft));
  const compact = showReview || entryTab === "manual";

  return (
    <div className={`fb-tab-stack fb-new-expense-page fb-money-in-page${compact ? " fb-new-expense-page--review" : ""}`}>
      {compact ? (
        <div className="fb-review-mode-bar">
          <div className="fb-segmented fb-review-mode-bar__segments" role="tablist" aria-label="Money In entry type">
            <button
              type="button"
              role="tab"
              aria-selected={entryTab === "document"}
              aria-label="Upload Document"
              className={`fb-segment ${entryTab === "document" ? "fb-segment--active" : ""}`}
              onClick={() => selectEntryTab("document")}
            >
              Document
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={entryTab === "manual"}
              aria-label="Manual Entry"
              className={`fb-segment ${entryTab === "manual" ? "fb-segment--active" : ""}`}
              onClick={() => selectEntryTab("manual")}
            >
              Manual
            </button>
          </div>
        </div>
      ) : (
        <section className="card fb-new-expense-hero">
          <p className="eyebrow">Money In</p>
          <h1 className="fb-dash-title">Record Money In</h1>
          <p className="fb-dash-subtitle">Record a check or payment from a document, or enter it manually.</p>
          <div className="fb-segmented" role="tablist" aria-label="Money In entry type">
            <button
              type="button"
              role="tab"
              aria-selected={entryTab === "document"}
              className={`fb-segment ${entryTab === "document" ? "fb-segment--active" : ""}`}
              onClick={() => selectEntryTab("document")}
            >
              Upload Document
            </button>
            <button type="button" role="tab" aria-selected="false" className="fb-segment" onClick={() => selectEntryTab("manual")}>
              Manual Entry
            </button>
          </div>
        </section>
      )}

      {showReview && form ? (
        <MoneyInForm
          key={draft?.id ?? "manual"}
          values={form}
          inline={Boolean(draft)}
          draft={draft}
          prefill={prefill}
          bankAccounts={bankAccounts}
          expenses={expenses}
          departmentId={departmentId}
          departmentCategories={departmentCategories}
          counterparties={counterparties}
          allowedCategories={allowedCategories}
          categorySuggestion={categoryTouched ? null : categorySuggestion}
          twoPctSuggestion={twoPctSuggestion}
          loggedBy={loggedByLabel(user)}
          busy={working}
          onChange={updateForm}
          onPayerCommitted={onPayerCommitted}
          onTwoPctSuggestionResolved={() => setTwoPctSuggestion(null)}
          onSubmit={record}
          onCancel={cancel}
        />
      ) : (
        <div className="fb-new-expense-stage">
          <DocumentUpload isMobileDevice={isMobileDevice} busy={working} onFileSelected={readDocument} />
        </div>
      )}
    </div>
  );
}

function MoneyInForm({
  values,
  inline,
  draft,
  prefill,
  bankAccounts,
  expenses,
  departmentId,
  departmentCategories,
  counterparties,
  allowedCategories,
  categorySuggestion,
  twoPctSuggestion,
  loggedBy,
  busy,
  onChange,
  onPayerCommitted,
  onTwoPctSuggestionResolved,
  onSubmit,
  onCancel,
}: {
  values: MoneyInFormValues;
  inline: boolean;
  draft: DocumentDraft | null;
  prefill?: MoneyInPrefill;
  bankAccounts: BankAccount[];
  expenses: ExpenseRecord[];
  departmentId: string;
  departmentCategories: DepartmentCategory[];
  counterparties: DepartmentCounterparty[];
  allowedCategories: string[];
  categorySuggestion: MoneyInCategorySuggestion | null;
  twoPctSuggestion: MoneyInTwoPercentSuggestion | null;
  loggedBy: string;
  busy: boolean;
  onChange: (values: MoneyInFormValues, changed: keyof MoneyInFormValues) => void;
  onPayerCommitted: (values: MoneyInFormValues) => void;
  onTwoPctSuggestionResolved: () => void;
  onSubmit: (values: MoneyInFormValues) => Promise<MoneyInValidationError | null>;
  onCancel: () => void;
}) {
  const [editing, setEditing] = useState<EditField>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const editRowRef = useRef<HTMLDivElement>(null);
  const isTransfer = values.mode === "transfer";
  const payerListId = `money-in-payers-${departmentId}`;

  const stopEditing = useCallback(() => setEditing(null), []);
  useDismissOnOutsideClick(editRowRef, stopEditing, inline && editing != null);

  useEffect(() => {
    if (!editing) return;
    editRowRef.current?.querySelector<HTMLElement>("input, select, textarea")?.focus();
  }, [editing]);

  useEffect(() => {
    if (!lightboxOpen && !editing) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (lightboxOpen) setLightboxOpen(false);
      else setEditing(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [lightboxOpen, editing]);

  function set<K extends keyof MoneyInFormValues>(field: K, value: MoneyInFormValues[K]) {
    onChange({ ...values, [field]: value }, field);
  }

  function changeCategory(next: string) {
    const wasTwoPctCategory = isTwoPercentIncomeCategory(values.category, departmentCategories);
    const isTwoPctCategory = isTwoPercentIncomeCategory(next, departmentCategories);
    onChange(
      {
        ...values,
        category: next,
        // Picking a 2% receipt category is an explicit 2% choice; leaving one undoes it.
        uses_two_percent_funds: isTwoPctCategory || (values.uses_two_percent_funds && !wasTwoPctCategory),
        related_expense_id: moneyInCategoryConfig(next)?.economicType === "refund" || moneyInCategoryConfig(next)?.key === "reimbursement"
          ? values.related_expense_id
          : "",
      },
      "category",
    );
    if (isTwoPctCategory) onTwoPctSuggestionResolved();
  }

  function changePaymentMethod(next: string) {
    onChange(
      {
        ...values,
        payment_method: next,
        deposit_status: prefill?.bank ? "deposited" : defaultDepositStatus(next, draft?.extracted.document_type),
      },
      "payment_method",
    );
  }

  const payerSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const c of counterparties) {
      const key = normalizeVendorKey(c.name);
      if (key && !seen.has(key)) {
        seen.add(key);
        names.push(c.name);
      }
    }
    for (const row of expenses) {
      if (row.department_id !== departmentId || !isMoneyInHistoryRow(row)) continue;
      const name = (row.payee || row.merchant_name || "").trim();
      const key = normalizeVendorKey(name);
      if (key && !seen.has(key)) {
        seen.add(key);
        names.push(name);
      }
    }
    return names.slice(0, 50);
  }, [counterparties, expenses, departmentId]);

  const history = useMemo(
    () => (isTransfer ? null : buildSourceHistory({ name: values.payer, ledgerRows: expenses, departmentId, recentLimit: 3 })),
    [isTransfer, values.payer, expenses, departmentId],
  );

  const refundConfig = moneyInCategoryConfig(values.category);
  const offersRefundLink = refundConfig?.economicType === "refund" || refundConfig?.key === "reimbursement";
  const refundCandidates = useMemo(() => {
    if (!offersRefundLink) return [];
    const payerKey = normalizeVendorKey(values.payer);
    return expenses
      .filter((row) => {
        if (row.department_id !== departmentId || isTypedMoneyInRow(row) || isMoneyInHistoryRow(row)) return false;
        const cents = parseCents(row.total_amount);
        if (cents == null || cents <= 0) return false;
        const samePayer = payerKey && normalizeVendorKey(row.payee || row.merchant_name) === payerKey;
        return samePayer || (values.amount_cents > 0 && cents >= values.amount_cents);
      })
      .sort((a, b) => (b.transaction_date || "").localeCompare(a.transaction_date || ""))
      .slice(0, 12);
  }, [offersRefundLink, expenses, departmentId, values.payer, values.amount_cents]);

  const depositAccount = bankAccounts.find((a) => sameName(a.name, values.deposit_account));
  const twoPctAccount = bankAccounts.find((a) => a.is_two_percent_account);
  const showCategoryChip =
    isBadgedSuggestion(categorySuggestion) && categorySuggestion && sameName(categorySuggestion.category, values.category);
  const offeredTwoPct = Boolean(twoPctSuggestion) && !values.uses_two_percent_funds;
  const suggestTwoPctAccount =
    values.uses_two_percent_funds && twoPctAccount && !sameName(twoPctAccount.name, values.deposit_account);
  const amountLabel = values.amount_cents > 0 ? formatUsdCents(values.amount_cents) : "";
  const isDonorCategory = Boolean(refundConfig?.donor);
  const isGrant = refundConfig?.key === "grant";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const invalid = await onSubmit(values);
    if (invalid) setEditing(invalid.field);
  }

  const accountRow = (field: "account" | "from_account", label: string, value: string, key: "deposit_account" | "transfer_from_account") => {
    const account = bankAccounts.find((a) => sameName(a.name, value));
    return (
      <FieldRow
        icon="account"
        label={label}
        display={value}
        empty="Choose account"
        sub={accountMeta(account) || undefined}
        editing={editing === field}
        inline={inline}
        onEdit={() => setEditing(field)}
        rowRef={editRowRef}
      >
        <AccountSelect label={label} value={value} onChange={(v) => set(key, v)} bankAccounts={bankAccounts} required />
      </FieldRow>
    );
  };

  return (
    <div className="fb-review-stack">
      {prefill?.bank ? (
        <div className="fb-stmt-prefill-note">
          <strong>From your bank feed.</strong> This deposit is already in your bank account. Confirm the details and
          Hallix will link the two so it is counted once.
        </div>
      ) : null}
      {draft?.extracted.notes ? <div className="integration-note fb-review-note">{draft.extracted.notes}</div> : null}

      {draft ? (
        <section className="card fb-receipt-summary-card">
          <div className="fb-receipt-summary">
            <div className="fb-receipt-thumb-wrap">
              {draft.previewUrl ? (
                <img className="fb-receipt-thumb" src={draft.previewUrl} alt={`Document from ${values.payer || "payer"}`} />
              ) : (
                <div className="fb-receipt-thumb fb-receipt-thumb--placeholder" aria-hidden="true">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                </div>
              )}
            </div>
            <div className="fb-receipt-summary-copy">
              <p className="fb-receipt-summary-title">Payment captured</p>
              <p className="fb-receipt-summary-vendor">{values.payer || draft.file.name || "Document"}</p>
              <p className="fb-receipt-summary-meta">
                {[formatFriendlyDate(values.date_received), amountLabel].filter(Boolean).join(" · ")}
              </p>
              {draft.previewUrl ? (
                <button type="button" className="fb-view-receipt-link" onClick={() => setLightboxOpen(true)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                  View document
                </button>
              ) : (
                <p className="fb-receipt-summary-meta">PDF attached — open after saving from Transactions.</p>
              )}
            </div>
          </div>
        </section>
      ) : null}

      <form className="fb-review-form fb-expense-form fb-money-in-form" onSubmit={handleSubmit} noValidate>
        <section className="card fb-extracted-card">
          {inline ? (
            <p className="fb-extracted-eyebrow">{isTransfer ? "Internal transfer" : "Received funds"}</p>
          ) : (
            <div className="fb-manual-head">
              <p className="fb-extracted-eyebrow">{isTransfer ? "Internal transfer" : "Received funds"}</p>
              <h2 className="fb-manual-title">{isTransfer ? "Transfer details" : "Money In details"}</h2>
            </div>
          )}

          <div className={`fb-extracted-grid${inline ? "" : " fb-manual-grid"}`}>
            <FieldRow
              icon="date"
              label={isTransfer ? "Transfer date" : "Date received"}
              display={values.date_received ? formatDisplayDate(values.date_received) : ""}
              empty="Add date"
              editing={editing === "date"}
              inline={inline}
              onEdit={() => setEditing("date")}
              rowRef={editRowRef}
            >
              <label>
                {isTransfer ? "Transfer date" : "Date received"}
                <input type="date" value={values.date_received} onChange={(e) => set("date_received", e.target.value)} required />
              </label>
            </FieldRow>

            {isTransfer ? (
              accountRow("from_account", "From account", values.transfer_from_account, "transfer_from_account")
            ) : (
              <FieldRow
                icon="source"
                label="From / Source"
                display={values.payer}
                empty="Add source / payer"
                sub={
                  history ? (
                    <span className="fb-money-in-history-line">
                      {history.count} earlier · {formatUsdCents(history.lifetimeCents)} {history.totalLabel.toLowerCase()}
                      {history.lastDate ? ` · last ${formatFriendlyDate(history.lastDate)}` : ""}
                    </span>
                  ) : undefined
                }
                editing={editing === "payer"}
                inline={inline}
                onEdit={() => setEditing("payer")}
                rowRef={editRowRef}
              >
                <label>
                  From / Source
                  <input
                    value={values.payer}
                    list={payerListId}
                    autoComplete="off"
                    placeholder="Who sent this money?"
                    onChange={(e) => set("payer", e.target.value)}
                    onBlur={(e) => onPayerCommitted({ ...values, payer: e.target.value })}
                    required
                  />
                  <datalist id={payerListId}>
                    {payerSuggestions.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                </label>
              </FieldRow>
            )}

            <FieldRow
              icon="amount"
              label="Amount"
              display={amountLabel}
              empty="Add amount"
              editing={editing === "amount"}
              inline={inline}
              onEdit={() => setEditing("amount")}
              rowRef={editRowRef}
            >
              <MoneyInput label="Amount" cents={values.amount_cents} onChange={(c) => set("amount_cents", c)} required />
            </FieldRow>

            {accountRow("account", isTransfer ? "To account" : "Deposit account", values.deposit_account, "deposit_account")}

            {isTransfer ? (
              <p className="fb-money-in-note">
                Transfers move money between your own accounts. They change account balances only and are never counted
                as income or spending.
              </p>
            ) : (
              <>
                <FieldRow
                  icon="category"
                  label="Source / Category"
                  display={values.category}
                  empty="Choose source"
                  chip={
                    showCategoryChip ? (
                      <span className="fb-suggested-chip fb-suggested-chip--positive" title={categorySuggestion?.reason}>
                        Suggested
                      </span>
                    ) : null
                  }
                  editing={editing === "category"}
                  inline={inline}
                  onEdit={() => setEditing("category")}
                  rowRef={editRowRef}
                >
                  <label>
                    Source / Category
                    <select value={values.category} onChange={(e) => changeCategory(e.target.value)} required>
                      <option value="">Choose source</option>
                      {allowedCategories.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {showCategoryChip && !inline ? (
                    <span className="fb-suggested-chip fb-suggested-chip--positive" title={categorySuggestion?.reason}>
                      Suggested
                    </span>
                  ) : null}
                </FieldRow>

                <div className="fb-detail-row">
                  <span className="fb-detail-icon">
                    <MoneyInIcon kind="two_percent" />
                  </span>
                  <div className="fb-detail-2pct">
                    <span className="fb-detail-label">2% Funds</span>
                    <span className="fb-detail-value fb-detail-value--inline">
                      {values.uses_two_percent_funds ? "2% Funds Received" : offeredTwoPct ? "Suggested" : "Not 2% Funds"}
                      {values.uses_two_percent_funds || offeredTwoPct ? (
                        <span
                          className="fb-detail-info"
                          title="Hallix guidance only — confirm with department policy before reporting."
                          aria-label="2% funds guidance"
                        >
                          i
                        </span>
                      ) : null}
                    </span>
                    {values.uses_two_percent_funds ? (
                      <span className="fb-detail-sub">Counts toward 2% Funds received.</span>
                    ) : offeredTwoPct ? (
                      <span className="fb-detail-sub">{twoPctSuggestion?.reason}</span>
                    ) : null}
                    <label className="fb-2pct-tag-label">
                      <input
                        type="checkbox"
                        checked={values.uses_two_percent_funds}
                        onChange={(e) => {
                          set("uses_two_percent_funds", e.target.checked);
                          onTwoPctSuggestionResolved();
                        }}
                      />
                      <span>Mark as 2% Funds received</span>
                    </label>
                    {offeredTwoPct ? (
                      <div className="fb-2pct-suggestion-actions">
                        <button
                          type="button"
                          className="fb-secondary-btn fb-2pct-suggestion-btn"
                          onClick={() => {
                            set("uses_two_percent_funds", true);
                            onTwoPctSuggestionResolved();
                          }}
                        >
                          Use 2% Funds
                        </button>
                        <button type="button" className="link-button fb-2pct-suggestion-dismiss" onClick={onTwoPctSuggestionResolved}>
                          Dismiss
                        </button>
                      </div>
                    ) : null}
                    {suggestTwoPctAccount && twoPctAccount ? (
                      <div className="fb-money-in-account-hint">
                        <span>Deposit to {twoPctAccount.name}?</span>
                        <button type="button" className="link-button" onClick={() => set("deposit_account", twoPctAccount.name)}>
                          Use account
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </>
            )}
          </div>

          <button
            type="button"
            className="link-button fb-money-in-mode-switch"
            onClick={() =>
              onChange(
                {
                  ...values,
                  mode: isTransfer ? "money_in" : "transfer",
                  uses_two_percent_funds: isTransfer ? values.uses_two_percent_funds : false,
                },
                "mode",
              )
            }
          >
            {isTransfer ? "This is money from an outside source" : "Moving money between your own accounts? Record a transfer"}
          </button>
        </section>

        <section className="card fb-more-details-card">
          <button type="button" className="fb-more-details-trigger" aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)}>
            <span className="fb-more-details-icon" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="8" y1="13" x2="16" y2="13" />
                <line x1="8" y1="17" x2="13" y2="17" />
              </svg>
            </span>
            <span className="fb-more-details-copy">
              <strong>More details</strong>
              <span>Check #, deposit, memo, restrictions…</span>
            </span>
            <span className={`fb-more-details-chevron${moreOpen ? " is-open" : ""}`} aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </span>
          </button>
          {moreOpen ? (
            <div className="fb-more-details-body">
              <div className="fb-more-details-group">
                <p className="fb-more-details-group-title">Payment details</p>
                <div className="form-grid two-column">
                  <label>
                    Payment method
                    <select value={values.payment_method} onChange={(e) => changePaymentMethod(e.target.value)}>
                      <option value="">Choose</option>
                      {MONEY_IN_PAYMENT_METHODS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Check / reference #
                    <input
                      value={values.check_number}
                      maxLength={12}
                      autoComplete="off"
                      placeholder="e.g. 1042"
                      onChange={(e) => set("check_number", e.target.value)}
                    />
                  </label>
                </div>
              </div>

              {!isTransfer ? (
                <div className="fb-more-details-group">
                  <p className="fb-more-details-group-title">Deposit</p>
                  <div className="fb-segmented fb-money-in-deposit-toggle" role="radiogroup" aria-label="Deposit status">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={values.deposit_status === "received"}
                      className={`fb-segment ${values.deposit_status === "received" ? "fb-segment--active" : ""}`}
                      disabled={Boolean(prefill?.bank)}
                      onClick={() => set("deposit_status", "received")}
                    >
                      Received, not deposited
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={values.deposit_status === "deposited"}
                      className={`fb-segment ${values.deposit_status === "deposited" ? "fb-segment--active" : ""}`}
                      onClick={() => set("deposit_status", "deposited")}
                    >
                      Deposited
                    </button>
                  </div>
                  {values.deposit_status === "deposited" ? (
                    <div className="form-grid two-column">
                      <label>
                        Deposit date
                        <input type="date" value={values.deposit_date} onChange={(e) => set("deposit_date", e.target.value)} />
                      </label>
                    </div>
                  ) : (
                    <p className="fb-field-hint">Mark it as deposited from Transactions once it goes to the bank.</p>
                  )}
                </div>
              ) : null}

              <div className="fb-more-details-group">
                <p className="fb-more-details-group-title">Notes</p>
                <label>
                  Memo
                  <textarea rows={2} value={values.memo} onChange={(e) => set("memo", e.target.value)} />
                </label>
                {!isTransfer ? (
                  <div className="form-grid two-column">
                    <label>
                      Fund / designation
                      <input value={values.fund} onChange={(e) => set("fund", e.target.value)} placeholder="General, building fund…" />
                    </label>
                    <label>
                      Restrictions
                      <input
                        value={values.restriction}
                        onChange={(e) => set("restriction", e.target.value)}
                        placeholder="e.g. equipment purchases only"
                      />
                    </label>
                    {isGrant || values.grant_reference ? (
                      <label>
                        Grant reference
                        <input value={values.grant_reference} onChange={(e) => set("grant_reference", e.target.value)} />
                      </label>
                    ) : null}
                  </div>
                ) : null}
                {!isTransfer ? (
                  <label>
                    {isDonorCategory ? "Donor notes" : "Source notes"}
                    <textarea rows={2} value={values.donor_note} onChange={(e) => set("donor_note", e.target.value)} />
                  </label>
                ) : null}
              </div>

              {offersRefundLink ? (
                <div className="fb-more-details-group">
                  <p className="fb-more-details-group-title">Original expense</p>
                  <label>
                    Refund of
                    <select value={values.related_expense_id} onChange={(e) => set("related_expense_id", e.target.value)}>
                      <option value="">Not linked</option>
                      {refundCandidates.map((row) => (
                        <option key={row.id} value={row.id}>
                          {[formatFriendlyDate(row.transaction_date), row.payee || row.merchant_name || "Expense", formatUsdCents(Math.abs(parseCents(row.total_amount) ?? 0))]
                            .filter(Boolean)
                            .join(" · ")}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="fb-field-hint">Refunds reduce spending. They are not counted as income.</p>
                </div>
              ) : null}

              <p className="fb-review-logged-by">Logged by {loggedBy}</p>
            </div>
          ) : null}
        </section>

        <div className="fb-review-actions">
          <button type="submit" className="fb-primary-btn fb-review-confirm" disabled={busy}>
            {busy ? "Saving…" : isTransfer ? "Confirm and record transfer" : "Confirm and record money in"}
          </button>
          <button type="button" className="fb-review-cancel" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>

      {lightboxOpen && draft?.previewUrl ? (
        <div
          className="fb-receipt-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Document preview"
          onClick={() => setLightboxOpen(false)}
        >
          <div className="fb-receipt-lightbox-panel" onClick={(event) => event.stopPropagation()}>
            <div className="fb-receipt-lightbox-bar">
              <p>Document preview</p>
              <button type="button" className="fb-receipt-lightbox-close" onClick={() => setLightboxOpen(false)}>
                Close
              </button>
            </div>
            <img src={draft.previewUrl} alt={`Document from ${values.payer || "payer"}`} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
