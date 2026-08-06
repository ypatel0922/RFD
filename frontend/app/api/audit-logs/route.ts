import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import { isAuditTrailEnabledForDepartment } from "../../../lib/audit-server";

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

/** GET /api/audit-logs?departmentId=...&from=...&to=...&userId=...&action=...&resourceType=...&search=... */
export async function GET(request: NextRequest) {
  const supabase = supabaseFromRequest(request);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const departmentId = searchParams.get("departmentId");
  if (!departmentId) {
    return NextResponse.json({ error: "Missing departmentId." }, { status: 400 });
  }

  const { data: membership } = await supabase
    .from("department_members")
    .select("role")
    .eq("department_id", departmentId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!membership) {
    return NextResponse.json({ error: "Not a member of this department." }, { status: 403 });
  }

  const auditTrailEnabled = await isAuditTrailEnabledForDepartment(departmentId);
  if (!auditTrailEnabled) {
    return NextResponse.json({ logs: [], auditTrailEnabled: false });
  }

  let query = supabase
    .from("audit_logs")
    .select("*")
    .eq("department_id", departmentId)
    .order("created_at", { ascending: false })
    .limit(1000);

  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const userId = searchParams.get("userId");
  const action = searchParams.get("action");
  const resourceType = searchParams.get("resourceType");
  const search = searchParams.get("search")?.trim();

  if (from) query = query.gte("created_at", from);
  if (to) query = query.lte("created_at", `${to}T23:59:59.999Z`);
  if (userId) query = query.eq("user_id", userId);
  if (action) query = query.eq("action", action);
  if (resourceType) query = query.eq("resource_type", resourceType);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let rows = data || [];
  if (search) {
    const needle = search.toLowerCase();
    rows = rows.filter((row) => {
      const haystack = [
        row.user_email,
        row.action,
        row.resource_type,
        row.resource_label,
        row.resource_id,
        JSON.stringify(row.metadata),
        JSON.stringify(row.before_data),
        JSON.stringify(row.after_data),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }

  return NextResponse.json({ logs: rows, auditTrailEnabled: true });
}
