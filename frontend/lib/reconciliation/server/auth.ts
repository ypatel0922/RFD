/**
 * Request authentication and department authorization for reconciliation routes.
 *
 * Two layers deliberately:
 *  - Every request is authenticated from its bearer token and its department
 *    membership is checked explicitly on the server.
 *  - All database work then goes through a *user-scoped* Supabase client, so the
 *    row level security policies enforce the same isolation independently. A bug
 *    in this file cannot leak another department's data.
 *
 * The service role key is never used here.
 */

import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

export type AuthorizedContext = {
  supabase: SupabaseClient;
  user: User;
  userEmail: string | null;
  departmentId: string;
  role: string;
};

export type AuthFailure = { status: number; message: string };

export function isAuthFailure(value: unknown): value is AuthFailure {
  return typeof value === "object" && value !== null && "status" in value && "message" in value;
}

function bearerToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return token || null;
}

/** A Supabase client that acts as the signed-in user, so RLS applies. */
export function userScopedClient(token: string): SupabaseClient | AuthFailure {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return { status: 500, message: "This server is not configured to reconcile statements." };
  }
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
}

/**
 * Authenticate the caller and confirm they belong to `departmentId`.
 * Returns an `AuthFailure` rather than throwing so routes stay linear.
 */
export async function authorizeDepartmentRequest(
  request: NextRequest,
  departmentId: string | null | undefined,
): Promise<AuthorizedContext | AuthFailure> {
  const token = bearerToken(request);
  if (!token) return { status: 401, message: "Please sign in again." };

  if (!departmentId || !isUuid(departmentId)) {
    return { status: 400, message: "A department must be selected." };
  }

  const supabase = userScopedClient(token);
  if (isAuthFailure(supabase)) return supabase;

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) {
    return { status: 401, message: "Your session has expired. Please sign in again." };
  }

  const { data: membership, error: membershipError } = await supabase
    .from("department_members")
    .select("role")
    .eq("department_id", departmentId)
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (membershipError || !membership) {
    return { status: 403, message: "You do not have access to this department." };
  }

  return {
    supabase,
    user: userData.user,
    userEmail: userData.user.email ?? null,
    departmentId,
    role: String(membership.role || ""),
  };
}

export type BankAccountForReconciliation = {
  id: string;
  name: string;
  institution_name: string | null;
  account_mask: string | null;
  account_type: string | null;
  last_reconciled_statement_end_date: string | null;
  last_reconciled_ending_balance: string | number | null;
};

/** Confirm the chosen account exists and belongs to the caller's department. */
export async function requireDepartmentBankAccount(
  context: AuthorizedContext,
  bankAccountId: string,
): Promise<BankAccountForReconciliation | AuthFailure> {
  if (!isUuid(bankAccountId)) {
    return { status: 400, message: "Choose the bank account you are reconciling." };
  }
  const { data, error } = await context.supabase
    .from("bank_accounts")
    .select(
      "id,name,institution_name,account_mask,account_type,last_reconciled_statement_end_date,last_reconciled_ending_balance",
    )
    .eq("id", bankAccountId)
    .eq("department_id", context.departmentId)
    .maybeSingle();

  if (error || !data) {
    return { status: 404, message: "That bank account is not set up for this department." };
  }
  return data as BankAccountForReconciliation;
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}
