/**
 * GET /api/receipt-requests/info?code=FB-XXXX
 *
 * Public endpoint used by the web receipt upload page.
 * Returns basic info about a pending receipt request (no sensitive data).
 */
import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin } from "../../plaid/_lib";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code")?.toUpperCase();
  if (!code) {
    return NextResponse.json({ found: false }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const { data: rr } = await admin
    .from("receipt_requests")
    .select("id, status, request_code, transaction_id")
    .eq("request_code", code)
    .maybeSingle();

  if (!rr) {
    return NextResponse.json({ found: false });
  }

  if (rr.status !== "pending") {
    return NextResponse.json({ found: true, status: rr.status });
  }

  // Fetch transaction details for display
  const { data: extTx } = await admin
    .from("external_transactions")
    .select("description, amount, posted_date")
    .eq("id", rr.transaction_id)
    .maybeSingle();

  return NextResponse.json({
    found: true,
    status: rr.status,
    requestCode: rr.request_code,
    vendor: extTx?.description ?? null,
    amount: extTx?.amount != null ? Math.abs(Number(extTx.amount)) : null,
    date: extTx?.posted_date ?? null,
  });
}
