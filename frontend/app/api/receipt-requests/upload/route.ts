/**
 * POST /api/receipt-requests/upload
 *
 * Unauthenticated endpoint for the public receipt upload web page.
 * Accepts a receipt image + request code, runs OCR, and attaches to the transaction.
 * Mirrors the logic in the Twilio inbound webhook but for web uploads.
 */
import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin } from "../../plaid/_lib";
import { logAuditEvent } from "../../../../lib/audit-server";
import { isMissingReceiptPath } from "../../../../lib/twilio";
import {
  compareReceiptToTransaction,
  extractReceiptFromBuffer,
  parseReceiptAmount,
} from "../../../../lib/extract-receipt-server";

function extensionForMime(mime: string): string {
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  return ".bin";
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const code = String(formData.get("code") || "").toUpperCase().trim();
  const receiptFile = formData.get("receipt");

  if (!code) return NextResponse.json({ error: "Missing request code." }, { status: 400 });
  if (!(receiptFile instanceof File)) {
    return NextResponse.json({ error: "No receipt file provided." }, { status: 400 });
  }

  const admin = supabaseAdmin();

  const { data: rr } = await admin
    .from("receipt_requests")
    .select("*")
    .eq("request_code", code)
    .eq("status", "pending")
    .maybeSingle();

  if (!rr) {
    return NextResponse.json({ error: "Receipt request not found or already completed." }, { status: 404 });
  }

  const bytes = Buffer.from(await receiptFile.arrayBuffer());
  const mimeType = receiptFile.type || "image/jpeg";
  const ocrResult = await extractReceiptFromBuffer(bytes, mimeType);

  const bucket = process.env.NEXT_PUBLIC_SUPABASE_RECEIPTS_BUCKET || "receipts";
  const departmentId = rr.department_id as string;
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const expenseId = crypto.randomUUID();
  const receiptId = crypto.randomUUID();
  const ext = extensionForMime(mimeType);
  const storagePath = `${departmentId}/${year}/${month}/${expenseId}/${receiptId}-${now.getTime()}${ext}`;

  const { error: uploadError } = await admin.storage
    .from(bucket)
    .upload(storagePath, bytes, { contentType: mimeType, upsert: false });

  if (uploadError) {
    return NextResponse.json({ error: "Could not save receipt file." }, { status: 500 });
  }

  const { data: extTx } = await admin
    .from("external_transactions")
    .select("id, department_id, description, amount, posted_date, expense_id")
    .eq("id", rr.transaction_id)
    .maybeSingle();

  const filename = `web-receipt-${now.getTime()}${ext}`;
  const vendor = ocrResult.merchant_name || extTx?.description || "Unknown vendor";
  const amount = parseReceiptAmount(ocrResult.total_amount) ?? (extTx ? Math.abs(extTx.amount) : 0);

  if (extTx?.expense_id) {
    const existingExpense = await admin
      .from("expenses")
      .select("receipt_path")
      .eq("id", extTx.expense_id)
      .maybeSingle();

    if (existingExpense.data && isMissingReceiptPath(existingExpense.data.receipt_path)) {
      await admin
        .from("expenses")
        .update({
          receipt_path: storagePath,
          receipt_id: receiptId,
          original_filename: filename,
          content_type: mimeType,
          payee: ocrResult.merchant_name ?? undefined,
          merchant_name: ocrResult.merchant_name ?? undefined,
          transaction_date: ocrResult.transaction_date ?? undefined,
          total_amount: parseReceiptAmount(ocrResult.total_amount) ?? undefined,
          tax_amount: parseReceiptAmount(ocrResult.tax_amount) ?? undefined,
          category: ocrResult.category ?? undefined,
          extraction_status: ocrResult.extraction_status,
          extraction_confidence: ocrResult.confidence,
          extraction_notes: ocrResult.notes,
        })
        .eq("id", extTx.expense_id);
    }
  } else {
    const txDate =
      ocrResult.transaction_date || extTx?.posted_date || now.toISOString().slice(0, 10);

    await admin.from("expenses").insert({
      id: expenseId,
      department_id: departmentId,
      receipt_id: receiptId,
      receipt_path: storagePath,
      original_filename: filename,
      content_type: mimeType,
      created_by_user_id: rr.user_id,
      uploaded_by: "Web Receipt Upload",
      payee: vendor,
      merchant_name: ocrResult.merchant_name || vendor,
      transaction_date: txDate,
      total_amount: amount,
      tax_amount: parseReceiptAmount(ocrResult.tax_amount),
      category: ocrResult.category,
      payment_method: ocrResult.payment_method,
      payment_reference: ocrResult.payment_reference,
      bank_amount: extTx?.amount,
      bank_posted_date: extTx?.posted_date,
      bank_description: extTx?.description,
      extraction_status: ocrResult.extraction_status,
      extraction_confidence: ocrResult.confidence,
      extraction_notes: ocrResult.notes,
      reconciliation_status: extTx ? "matched" : "pending_bank_match",
    });

    if (extTx) {
      await admin
        .from("external_transactions")
        .update({ expense_id: expenseId, match_status: "matched", match_confidence: 0.9 })
        .eq("id", extTx.id);
    }
  }

  // Check for OCR mismatch
  if (extTx) {
    const ocrAmount = parseReceiptAmount(ocrResult.total_amount);
    const { mismatch } = compareReceiptToTransaction({
      ocrAmount,
      ocrVendor: ocrResult.merchant_name,
      ocrDate: ocrResult.transaction_date,
      txAmount: extTx.amount,
      txDescription: extTx.description,
      txDate: extTx.posted_date,
    });
    if (mismatch) {
      const targetId = extTx.expense_id || expenseId;
      await admin
        .from("expenses")
        .update({
          extraction_status: "needs_review",
          extraction_notes: `Receipt needs review: ${mismatch}`,
        })
        .eq("id", targetId);
    }
  }

  const nowIso = now.toISOString();
  await admin
    .from("receipt_requests")
    .update({
      status: "completed",
      completed_at: nowIso,
      expense_id: extTx?.expense_id || expenseId,
      updated_at: nowIso,
    })
    .eq("id", rr.id);

  const targetExpenseId = extTx?.expense_id || expenseId;
  await logAuditEvent({
    departmentId,
    userId: (rr.user_id as string | null) ?? null,
    action: extTx?.expense_id ? "receipt.replaced" : "receipt.uploaded",
    resourceType: "expense",
    resourceId: targetExpenseId,
    resourceLabel: vendor,
    metadata: { source: "web_upload", requestCode: code },
    request,
  });

  return NextResponse.json({ ok: true, vendor, amount });
}
