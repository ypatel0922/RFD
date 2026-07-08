import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import { supabaseAdmin } from "../plaid/_lib";

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

/** GET /api/user-notification-prefs?departmentId=... */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const departmentId = searchParams.get("departmentId");
  if (!departmentId) {
    return NextResponse.json({ error: "Missing departmentId." }, { status: 400 });
  }

  const supabase = supabaseFromRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from("user_notification_prefs")
    .select("*")
    .eq("user_id", user.id)
    .eq("department_id", departmentId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // If no record exists yet, return defaults
  if (!data) {
    // Fall back to user_metadata.phone
    const adminUserResult = await admin.auth.admin.getUserById(user.id);
    const metaPhone = (adminUserResult.data.user?.user_metadata?.phone as string | undefined) || null;
    return NextResponse.json({
      user_id: user.id,
      department_id: departmentId,
      sms_receipt_requests_enabled: true,
      phone_number: metaPhone,
    });
  }

  // Merge with user_metadata.phone if pref phone is empty
  if (!data.phone_number) {
    const adminUserResult = await admin.auth.admin.getUserById(user.id);
    const metaPhone = (adminUserResult.data.user?.user_metadata?.phone as string | undefined) || null;
    return NextResponse.json({ ...data, phone_number: metaPhone });
  }

  return NextResponse.json(data);
}

/** POST /api/user-notification-prefs */
export async function POST(request: NextRequest) {
  const supabase = supabaseFromRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await request.json()) as {
    departmentId: string;
    smsReceiptRequestsEnabled?: boolean;
    phoneNumber?: string | null;
  };
  const { departmentId, smsReceiptRequestsEnabled, phoneNumber } = body;
  if (!departmentId) {
    return NextResponse.json({ error: "Missing departmentId." }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const now = new Date().toISOString();

  const { data, error } = await admin
    .from("user_notification_prefs")
    .upsert(
      {
        user_id: user.id,
        department_id: departmentId,
        sms_receipt_requests_enabled: smsReceiptRequestsEnabled ?? true,
        phone_number: phoneNumber ?? null,
        updated_at: now,
      },
      { onConflict: "user_id,department_id" },
    )
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}
