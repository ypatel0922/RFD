import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import { isAuditTrailEnabledForDepartment, logAuditEvent } from "../../../lib/audit-server";

function supabaseFromRequest(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
}

/** POST /api/audit-log — authenticated client-side audit event logging */
export async function POST(request: NextRequest) {
  const supabase = supabaseFromRequest(request);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await request.json()) as {
    departmentId?: string;
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

  if (!body.action || !body.resourceType) {
    return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
  }

  let departmentId = body.departmentId || "";
  if (!departmentId) {
    const { data: memberships } = await supabase
      .from("department_members")
      .select("department_id, role")
      .eq("user_id", user.id)
      .limit(1);
    departmentId = memberships?.[0]?.department_id ?? "";
  }

  const { data: membership } = await supabase
    .from("department_members")
    .select("role")
    .eq("department_id", departmentId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!membership || !departmentId) {
    return NextResponse.json({ error: "Not a member of this department." }, { status: 403 });
  }

  if (!(await isAuditTrailEnabledForDepartment(departmentId))) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  await logAuditEvent({
    departmentId,
    userId: body.userId ?? user.id,
    userEmail: body.userEmail ?? user.email ?? null,
    userRole: body.userRole ?? membership.role ?? null,
    action: body.action,
    resourceType: body.resourceType,
    resourceId: body.resourceId,
    resourceLabel: body.resourceLabel,
    beforeData: body.beforeData,
    afterData: body.afterData,
    metadata: body.metadata,
    request,
  });

  return NextResponse.json({ ok: true });
}
