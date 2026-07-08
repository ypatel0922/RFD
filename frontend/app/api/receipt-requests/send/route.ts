/**
 * POST /api/receipt-requests/send
 *
 * Manually trigger (or re-send) a receipt request SMS for an external transaction.
 * Used from the Reconciliation and Transactions UI.
 *
 * Body: { departmentId: string, transactionId: string }
 * transactionId is external_transactions.id
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import { supabaseAdmin } from "../../plaid/_lib";
import {
  buildReceiptRequestMessage,
  generateRequestCode,
  normalizePhone,
  sendSms,
} from "../../../../lib/twilio";

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

export async function POST(request: NextRequest) {
  const supabase = supabaseFromRequest(request);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await request.json()) as { departmentId: string; transactionId: string };
  const { departmentId, transactionId } = body;
  if (!departmentId || !transactionId) {
    return NextResponse.json({ error: "Missing departmentId or transactionId." }, { status: 400 });
  }

  const admin = supabaseAdmin();

  // Verify caller is a department member
  const { data: membership } = await admin
    .from("department_members")
    .select("role")
    .eq("department_id", departmentId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership) {
    return NextResponse.json({ error: "Not a department member." }, { status: 403 });
  }

  // Fetch the external transaction
  const { data: extTx, error: txError } = await admin
    .from("external_transactions")
    .select("id, department_id, description, amount, posted_date, expense_id")
    .eq("id", transactionId)
    .eq("department_id", departmentId)
    .maybeSingle();
  if (txError || !extTx) {
    return NextResponse.json({ error: "Transaction not found." }, { status: 404 });
  }

  // Check for existing pending receipt request
  const { data: existing } = await admin
    .from("receipt_requests")
    .select("id, status, request_code, phone_number")
    .eq("transaction_id", transactionId)
    .eq("status", "pending")
    .maybeSingle();

  if (existing) {
    return NextResponse.json({
      ok: true,
      alreadyPending: true,
      requestCode: existing.request_code,
      phone: existing.phone_number,
      message: "A receipt request is already pending for this transaction.",
    });
  }

  // Find a phone number to send to
  const phone = await resolveDepartmentPhone(admin, departmentId, user.id);
  if (!phone) {
    return NextResponse.json({
      ok: false,
      error: "No SMS-enabled phone number found. Add one in Settings → Notifications.",
    }, { status: 422 });
  }

  const requestCode = generateRequestCode();
  const vendor = extTx.description || "Unknown vendor";
  const amount = extTx.amount;
  const date = extTx.posted_date || new Date().toISOString().slice(0, 10);
  const messageBody = buildReceiptRequestMessage({ amount, vendor, date, requestCode });

  let twilioSid: string | null = null;
  let sendError: string | null = null;
  try {
    const result = await sendSms({ to: normalizePhone(phone), body: messageBody });
    twilioSid = result.sid;
  } catch (err) {
    sendError = err instanceof Error ? err.message : "SMS send failed.";
  }

  const now = new Date().toISOString();
  const { data: inserted, error: insertError } = await admin
    .from("receipt_requests")
    .insert({
      department_id: departmentId,
      transaction_id: transactionId,
      expense_id: extTx.expense_id || null,
      user_id: user.id,
      phone_number: normalizePhone(phone),
      request_code: requestCode,
      status: sendError ? "failed" : "pending",
      sent_at: sendError ? null : now,
      twilio_message_sid: twilioSid,
    })
    .select()
    .single();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  if (sendError) {
    return NextResponse.json({ ok: false, error: sendError, request: inserted }, { status: 502 });
  }

  return NextResponse.json({ ok: true, requestCode, phone: normalizePhone(phone), request: inserted });
}

/** Find the best phone number for receipt requests in a department. */
async function resolveDepartmentPhone(
  admin: ReturnType<typeof supabaseAdmin>,
  departmentId: string,
  preferUserId: string,
): Promise<string | null> {
  // First check if the requesting user has a pref
  const { data: requesterPref } = await admin
    .from("user_notification_prefs")
    .select("phone_number, sms_receipt_requests_enabled")
    .eq("user_id", preferUserId)
    .eq("department_id", departmentId)
    .maybeSingle();

  if (requesterPref?.sms_receipt_requests_enabled && requesterPref.phone_number) {
    return requesterPref.phone_number;
  }

  // Then check any department member with SMS enabled
  const { data: prefs } = await admin
    .from("user_notification_prefs")
    .select("phone_number, user_id, sms_receipt_requests_enabled")
    .eq("department_id", departmentId)
    .eq("sms_receipt_requests_enabled", true)
    .not("phone_number", "is", null)
    .limit(1);

  if (prefs?.[0]?.phone_number) {
    return prefs[0].phone_number;
  }

  // Fall back to user_metadata.phone for the requesting user
  const { data: adminUser } = await admin.auth.admin.getUserById(preferUserId);
  const metaPhone = (adminUser.user?.user_metadata?.phone as string | undefined) || null;
  return metaPhone || null;
}
