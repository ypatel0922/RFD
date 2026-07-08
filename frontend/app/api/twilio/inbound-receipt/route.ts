/**
 * POST /api/twilio/inbound-receipt
 *
 * Twilio webhook that receives inbound SMS/MMS from users replying with receipt photos.
 * Validates the signature, matches the sender to a pending receipt_request,
 * downloads MMS images, runs OCR, saves the receipt, and updates the transaction.
 */
import { NextRequest, NextResponse } from "next/server";

import { supabaseAdmin } from "../../plaid/_lib";
import {
  buildAmbiguousReceiptMessage,
  buildNoMediaMessage,
  buildReceiptConfirmationMessage,
  buildTwimlResponse,
  downloadTwilioMedia,
  isMissingReceiptPath,
  normalizePhone,
  validateTwilioSignature,
} from "../../../../lib/twilio";
import {
  compareReceiptToTransaction,
  extractReceiptFromBuffer,
  parseReceiptAmount,
} from "../../../../lib/extract-receipt-server";

const TWIML_CONTENT_TYPE = "application/xml";

/** Parse Twilio's form-encoded webhook body into a flat record. */
async function parseTwilioBody(request: NextRequest): Promise<Record<string, string>> {
  const text = await request.text();
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(text)) {
    params[key] = value;
  }
  return params;
}

function twimlResponse(message: string) {
  return new NextResponse(buildTwimlResponse(message), {
    headers: { "Content-Type": TWIML_CONTENT_TYPE },
  });
}

function extensionForMime(mime: string): string {
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  if (mime === "application/pdf") return ".pdf";
  return ".bin";
}

export async function POST(request: NextRequest) {
  const params = await parseTwilioBody(request);

  // Validate Twilio signature (optional: only enforced when auth token is set)
  const signature = request.headers.get("x-twilio-signature");
  const appBaseUrl = process.env.APP_BASE_URL;
  if (process.env.TWILIO_AUTH_TOKEN && appBaseUrl) {
    const webhookUrl = `${appBaseUrl}/api/twilio/inbound-receipt`;
    if (!validateTwilioSignature(signature, webhookUrl, params)) {
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  const fromRaw = params.From || "";
  const body = (params.Body || "").trim();
  const numMedia = parseInt(params.NumMedia || "0", 10);
  const from = normalizePhone(fromRaw);

  const admin = supabaseAdmin();

  // Find matching receipt_request
  const requestCodeMatch = body.match(/\bFB-\d{3,6}\b/i);
  let receiptRequest: ReceiptRequestRow | null = null;

  if (requestCodeMatch) {
    const code = requestCodeMatch[0].toUpperCase();
    const { data } = await admin
      .from("receipt_requests")
      .select("*")
      .eq("request_code", code)
      .eq("status", "pending")
      .maybeSingle();
    receiptRequest = data ?? null;
  }

  if (!receiptRequest) {
    // Match by phone number: find most recent pending request
    const { data: byPhone } = await admin
      .from("receipt_requests")
      .select("*")
      .eq("phone_number", from)
      .eq("status", "pending")
      .order("sent_at", { ascending: false })
      .limit(2);

    if (byPhone && byPhone.length > 1) {
      return twimlResponse(buildAmbiguousReceiptMessage());
    }
    receiptRequest = byPhone?.[0] ?? null;
  }

  if (!receiptRequest) {
    return twimlResponse(
      "Firebook received your message, but could not match it to a pending receipt request. " +
      "Reply with the reference code from the original message (e.g. FB-1234).",
    );
  }

  if (numMedia === 0) {
    return twimlResponse(buildNoMediaMessage());
  }

  // Download and process each media attachment
  const bucket = process.env.NEXT_PUBLIC_SUPABASE_RECEIPTS_BUCKET || "receipts";
  const departmentId = receiptRequest.department_id;

  let firstOcrResult: Awaited<ReturnType<typeof extractReceiptFromBuffer>> | null = null;
  let firstReceiptPath: string | null = null;
  let firstContentType: string | null = null;

  for (let i = 0; i < numMedia; i++) {
    const mediaUrl = params[`MediaUrl${i}`];
    const mediaContentType = params[`MediaContentType${i}`] || "image/jpeg";
    if (!mediaUrl) continue;

    let buffer: Buffer;
    try {
      const result = await downloadTwilioMedia(mediaUrl);
      buffer = result.buffer;
    } catch {
      continue;
    }

    // Run OCR on the first image
    const ocrResult = await extractReceiptFromBuffer(buffer, mediaContentType);
    if (!firstOcrResult) firstOcrResult = ocrResult;

    // Build storage path using temporary IDs (the final expense record uses different IDs)
    const pathExpenseId = crypto.randomUUID();
    const pathReceiptId = crypto.randomUUID();
    const pathNow = new Date();
    const year = pathNow.getFullYear();
    const month = String(pathNow.getMonth() + 1).padStart(2, "0");
    const ts = pathNow.getTime();
    const ext = extensionForMime(mediaContentType);
    const storagePath = `${departmentId}/${year}/${month}/${pathExpenseId}/${pathReceiptId}-${ts}${ext}`;

    // Upload to Supabase Storage
    const { error: uploadError } = await admin.storage
      .from(bucket)
      .upload(storagePath, buffer, { contentType: mediaContentType, upsert: false });

    if (uploadError) continue;

    if (!firstReceiptPath) {
      firstReceiptPath = storagePath;
      firstContentType = mediaContentType;
    }
  }

  if (!firstReceiptPath) {
    return twimlResponse(
      "Firebook received your message but could not save the receipt image. " +
      "Please try again with a clearer photo.",
    );
  }

  // Fetch the external transaction for this receipt request
  const { data: extTx } = await admin
    .from("external_transactions")
    .select("id, department_id, description, amount, posted_date, expense_id")
    .eq("id", receiptRequest.transaction_id)
    .maybeSingle();

  let expenseId: string;
  let vendor: string;
  let amount: number;

  if (extTx?.expense_id) {
    // Attach receipt to existing expense — only update receipt fields + extraction status.
    // Never overwrite user-confirmed payee/amount/date to avoid data loss.
    expenseId = extTx.expense_id;
    const receiptId = crypto.randomUUID();
    const filename = `sms-receipt-${Date.now()}.${firstContentType?.split("/")[1] || "jpg"}`;
    await admin
      .from("expenses")
      .update({
        receipt_path: firstReceiptPath,
        receipt_id: receiptId,
        original_filename: filename,
        content_type: firstContentType,
        extraction_status: firstOcrResult?.extraction_status ?? "needs_review",
        extraction_confidence: firstOcrResult?.confidence ?? 0,
        extraction_notes: firstOcrResult?.notes ?? null,
      })
      .eq("id", expenseId);

    const existing = await admin.from("expenses").select("payee,merchant_name,total_amount").eq("id", expenseId).maybeSingle();
    vendor = existing.data?.payee || existing.data?.merchant_name || extTx.description || "Unknown";
    amount = Math.abs(extTx.amount);
  } else {
    // Create new expense from external transaction + receipt
    expenseId = crypto.randomUUID();
    const receiptId = crypto.randomUUID();
    const filename = `sms-receipt-${Date.now()}.${firstContentType?.split("/")[1] || "jpg"}`;
    vendor = firstOcrResult?.merchant_name || extTx?.description || "Unknown vendor";
    amount = parseReceiptAmount(firstOcrResult?.total_amount) ?? (extTx ? Math.abs(extTx.amount) : 0);

    const userId = receiptRequest.user_id;
    let userEmail: string | null = null;
    if (userId) {
      const { data: u } = await admin.auth.admin.getUserById(userId);
      userEmail = u.user?.email ?? null;
    }

    const txDate = firstOcrResult?.transaction_date || extTx?.posted_date || new Date().toISOString().slice(0, 10);

    await admin.from("expenses").insert({
      id: expenseId,
      department_id: departmentId,
      receipt_id: receiptId,
      receipt_path: firstReceiptPath,
      original_filename: filename,
      content_type: firstContentType,
      created_by_user_id: userId,
      created_by_email: userEmail,
      uploaded_by: "SMS Receipt",
      payee: vendor,
      merchant_name: firstOcrResult?.merchant_name || vendor,
      transaction_date: txDate,
      total_amount: amount,
      tax_amount: parseReceiptAmount(firstOcrResult?.tax_amount),
      category: firstOcrResult?.category,
      payment_method: firstOcrResult?.payment_method,
      payment_reference: firstOcrResult?.payment_reference,
      description: firstOcrResult?.description,
      bank_amount: extTx?.amount,
      bank_posted_date: extTx?.posted_date,
      bank_description: extTx?.description,
      extraction_status: firstOcrResult?.extraction_status ?? "needs_review",
      extraction_confidence: firstOcrResult?.confidence ?? 0,
      extraction_notes: firstOcrResult?.notes,
      reconciliation_status: extTx ? "matched" : "pending_bank_match",
    });

    // Link external_transaction to the new expense
    if (extTx) {
      await admin
        .from("external_transactions")
        .update({
          expense_id: expenseId,
          match_status: "matched",
          match_confidence: 0.9,
        })
        .eq("id", extTx.id);
    }
  }

  // Compare OCR result to transaction for mismatch detection
  let ocrMismatch: string | null = null;
  if (firstOcrResult && extTx) {
    const ocrAmount = parseReceiptAmount(firstOcrResult.total_amount);
    const { mismatch } = compareReceiptToTransaction({
      ocrAmount,
      ocrVendor: firstOcrResult.merchant_name,
      ocrDate: firstOcrResult.transaction_date,
      txAmount: extTx.amount,
      txDescription: extTx.description,
      txDate: extTx.posted_date,
    });
    ocrMismatch = mismatch;

    if (ocrMismatch) {
      await admin
        .from("expenses")
        .update({
          extraction_status: "needs_review",
          extraction_notes: `Receipt needs review: ${ocrMismatch}`,
        })
        .eq("id", expenseId);
    }
  }

  // Mark receipt_request completed
  const now = new Date().toISOString();
  await admin
    .from("receipt_requests")
    .update({
      status: "completed",
      completed_at: now,
      expense_id: expenseId,
      inbound_message_sid: params.MessageSid || null,
      updated_at: now,
    })
    .eq("id", receiptRequest.id);

  const confirmationMessage = buildReceiptConfirmationMessage({ vendor, amount });
  return twimlResponse(
    ocrMismatch
      ? `${confirmationMessage} Note: the receipt may need a quick review in Firebook.`
      : confirmationMessage,
  );
}

type ReceiptRequestRow = {
  id: string;
  department_id: string;
  transaction_id: string;
  expense_id: string | null;
  user_id: string | null;
  phone_number: string;
  request_code: string;
  status: string;
  sent_at: string | null;
};
