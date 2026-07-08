import { NextRequest, NextResponse } from "next/server";

import { logAuditEvent } from "../../../../lib/audit-server";
import { supabaseAdmin } from "../../plaid/_lib";

/**
 * POST /api/audit-log/public
 * For unauthenticated auth events (e.g. password reset requested).
 * Resolves department from the user's email when possible.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    action: string;
    email?: string;
    resourceType?: string;
    metadata?: Record<string, unknown> | null;
  };

  if (!body.action) {
    return NextResponse.json({ error: "Missing action." }, { status: 400 });
  }

  const allowedActions = new Set(["auth.password_reset_requested"]);
  if (!allowedActions.has(body.action)) {
    return NextResponse.json({ error: "Action not allowed." }, { status: 403 });
  }

  const email = body.email?.trim().toLowerCase();
  if (!email) {
    return NextResponse.json({ error: "Missing email." }, { status: 400 });
  }

  let departmentId: string | null = null;
  let userId: string | null = null;

  try {
    const admin = supabaseAdmin();
    const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const matched = users.users.find((u) => u.email?.toLowerCase() === email);
    if (matched) {
      userId = matched.id;
      const { data: membership } = await admin
        .from("department_members")
        .select("department_id")
        .eq("user_id", matched.id)
        .limit(1)
        .maybeSingle();
      departmentId = membership?.department_id ?? null;
    }
  } catch {
    // Continue without user resolution
  }

  if (!departmentId) {
    // Cannot log without a department scope — skip silently
    return NextResponse.json({ ok: true, skipped: true });
  }

  await logAuditEvent({
    departmentId,
    userId,
    userEmail: email,
    action: body.action,
    resourceType: body.resourceType || "auth",
    resourceLabel: email,
    metadata: { email, ...(body.metadata || {}) },
    request,
  });

  return NextResponse.json({ ok: true });
}
