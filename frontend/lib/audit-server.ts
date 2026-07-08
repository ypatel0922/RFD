import type { NextRequest } from "next/server";

import { supabaseAdmin } from "../app/api/plaid/_lib";

export type AuditEventInput = {
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
  request?: NextRequest | null;
};

const SENSITIVE_KEY_PATTERN =
  /password|passwd|secret|token|api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|plaid|twilio|service[_-]?role/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function sanitizeValue(value: unknown): unknown {
  if (value == null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = "[redacted]";
    } else {
      out[key] = sanitizeValue(val);
    }
  }
  return out;
}

function sanitizeRecord(data: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!data) return null;
  return sanitizeValue(data) as Record<string, unknown>;
}

export async function isAuditTrailEnabledForDepartment(departmentId: string): Promise<boolean> {
  if (!departmentId) return false;

  try {
    const admin = supabaseAdmin();
    const { data, error } = await admin
      .from("department_settings")
      .select("audit_trail_enabled")
      .eq("department_id", departmentId)
      .maybeSingle();

    if (error) {
      console.warn("Could not read audit trail setting:", error.message);
      return false;
    }

    return Boolean(data?.audit_trail_enabled);
  } catch {
    return false;
  }
}

function requestMeta(request?: NextRequest | null): { ipAddress: string | null; userAgent: string | null } {
  if (!request) {
    return { ipAddress: null, userAgent: null };
  }
  const forwarded = request.headers.get("x-forwarded-for");
  const ipAddress = forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null;
  const userAgent = request.headers.get("user-agent") || null;
  return { ipAddress, userAgent };
}

/**
 * Server-side audit logger. Never throws — failures are logged with console.warn.
 */
export async function logAuditEvent(input: AuditEventInput): Promise<void> {
  try {
    if (!input.departmentId) return;
    const enabled = await isAuditTrailEnabledForDepartment(input.departmentId);
    if (!enabled) return;

    const admin = supabaseAdmin();
    const { ipAddress, userAgent } = requestMeta(input.request);

    const row = {
      department_id: input.departmentId,
      user_id: input.userId ?? null,
      user_email: input.userEmail ?? null,
      user_role: input.userRole ?? null,
      action: input.action,
      resource_type: input.resourceType,
      resource_id: input.resourceId ?? null,
      resource_label: input.resourceLabel ?? null,
      before_data: sanitizeRecord(input.beforeData),
      after_data: sanitizeRecord(input.afterData),
      metadata: sanitizeRecord(input.metadata),
      ip_address: ipAddress,
      user_agent: userAgent,
    };

    const { error } = await admin.from("audit_logs").insert(row);
    if (error) {
      console.warn("Audit logging failed:", error.message);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown audit logging error";
    console.warn("Audit logging failed:", message);
  }
}
