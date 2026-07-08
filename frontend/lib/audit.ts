import { supabase } from "./supabase";

export type { AuditEventInput } from "./audit-server";

export type AuditLogRecord = {
  id: string;
  department_id: string;
  user_id: string | null;
  user_email: string | null;
  user_role: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  resource_label: string | null;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
};

/** Human-readable labels for audit actions shown in the UI. */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  "auth.login_success": "Login",
  "auth.logout": "Logout",
  "auth.password_reset_requested": "Password reset requested",
  "auth.password_reset_completed": "Password reset completed",
  "transaction.created": "Transaction created",
  "transaction.edited": "Transaction edited",
  "transaction.deleted": "Transaction deleted",
  "receipt.uploaded": "Receipt uploaded",
  "receipt.replaced": "Receipt replaced",
  "ocr.fields_accepted": "OCR fields accepted",
  "ocr.fields_overridden": "OCR fields manually overridden",
  "transaction.category_changed": "Category changed",
  "transaction.bank_account_changed": "Bank account changed",
  "transaction.reconciled": "Transaction reconciled",
  "transaction.unreconciled": "Transaction unreconciled",
  "transaction.plaid_matched": "Receipt matched to Plaid transaction",
  "transaction.two_percent_flagged": "Flagged for 2% review",
  "transaction.two_percent_included": "Included in 2% report",
  "transaction.two_percent_excluded": "Excluded from 2% report",
  "bank_account.added": "Bank account added",
  "bank_account.edited": "Bank account edited",
  "bank_account.deleted": "Bank account deleted",
  "bank_account.nys_tagged": "Tagged as NYS 2% account",
  "bank_account.nys_untagged": "Untagged as NYS 2% account",
  "plaid.connected": "Plaid connected",
  "plaid.disconnected": "Plaid disconnected",
  "plaid.sync_run": "Plaid sync run",
  "plaid.transaction_imported": "Plaid transaction imported",
  "category.created": "Category created",
  "category.edited": "Category edited",
  "category.hidden": "Category hidden",
  "category.restored": "Category restored",
  "category.deleted": "Category deleted",
  "vendor.created": "Vendor created",
  "vendor.edited": "Vendor edited",
  "member.invited": "Member invited",
  "member.role_changed": "Member role changed",
  "member.removed": "Member removed",
  "permission.changed": "Permission changed",
  "sms_reminders.enabled": "SMS receipt reminders enabled",
  "sms_reminders.disabled": "SMS receipt reminders disabled",
  "phone.changed": "Phone number changed",
  "report.nys_draft_created": "NYS 2% report draft created",
  "report.nys_edited": "NYS 2% report edited",
  "report.nys_downloaded": "NYS 2% report downloaded",
  "report.nys_printed": "NYS 2% report printed",
  "report.prior_year_uploaded": "Prior-year filing uploaded",
  "report.prior_year_replaced": "Prior-year filing replaced",
  "report.generated": "Report generated",
  "report.downloaded": "Report downloaded",
};

export function formatAuditAction(action: string): string {
  return AUDIT_ACTION_LABELS[action] || action.replace(/[._]/g, " ");
}

type AuditTrailEnabledCacheEntry = { enabled: boolean; expiresAt: number };

const auditTrailEnabledCache = new Map<string, AuditTrailEnabledCacheEntry>();
const AUDIT_TRAIL_CACHE_TTL_MS = 30_000;

export function invalidateAuditTrailEnabledCache(departmentId?: string): void {
  if (departmentId) {
    auditTrailEnabledCache.delete(departmentId);
    return;
  }
  auditTrailEnabledCache.clear();
}

export async function isAuditTrailEnabled(departmentId: string): Promise<boolean> {
  if (!departmentId) return false;

  const cached = auditTrailEnabledCache.get(departmentId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.enabled;
  }

  try {
    const { data, error } = await supabase
      .from("department_settings")
      .select("audit_trail_enabled")
      .eq("department_id", departmentId)
      .maybeSingle();

    if (error) return false;

    const enabled = Boolean(data?.audit_trail_enabled);
    auditTrailEnabledCache.set(departmentId, {
      enabled,
      expiresAt: Date.now() + AUDIT_TRAIL_CACHE_TTL_MS,
    });
    return enabled;
  } catch {
    return false;
  }
}

type ClientAuditInput = {
  departmentId: string;
  userId?: string | null;
  userEmail?: string | null;
  userRole?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  resourceLabel?: string | null;
  beforeData?: Record<string, unknown> | null;
  afterData?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
};

/**
 * Log an audit event from the browser via the server API route.
 * Never throws — failures are logged with console.warn.
 */
export async function logAuditFromBrowser(input: ClientAuditInput): Promise<void> {
  try {
    if (!input.departmentId) return;
    if (!(await isAuditTrailEnabled(input.departmentId))) return;

    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) return;

    const payload = {
      ...input,
      userId: input.userId ?? session.user.id,
      userEmail: input.userEmail ?? session.user.email ?? null,
    };

    const response = await fetch("/api/audit-log", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      console.warn("Audit logging failed:", payload.error || response.statusText);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown audit logging error";
    console.warn("Audit logging failed:", message);
  }
}

/** Build a compact expense snapshot for before/after audit data. */
export function expenseAuditSnapshot(expense: {
  payee?: string | null;
  merchant_name?: string | null;
  total_amount?: unknown;
  transaction_date?: string | null;
  category?: string | null;
  bank_account_name?: string | null;
  description?: string | null;
  uses_two_percent_funds?: boolean | null;
  reconciliation_status?: string | null;
}): Record<string, unknown> {
  return {
    payee: expense.payee || expense.merchant_name || null,
    total_amount: expense.total_amount ?? null,
    transaction_date: expense.transaction_date ?? null,
    category: expense.category ?? null,
    bank_account_name: expense.bank_account_name ?? null,
    description: expense.description ?? null,
    uses_two_percent_funds: expense.uses_two_percent_funds ?? null,
    reconciliation_status: expense.reconciliation_status ?? null,
  };
}
