/**
 * Server-only receipt OCR helper.
 * Shared between the /api/extract-receipt HTTP route and the Twilio inbound webhook.
 * Never import in client components.
 */
import OpenAI from "openai";

import type { ExtractedReceiptData } from "./types";

export const FALLBACK_EXTRACTION: ExtractedReceiptData = {
  merchant_name: null,
  payee: null,
  transaction_date: null,
  total_amount: null,
  tax_amount: null,
  payment_reference: null,
  description: null,
  bank_account_name: null,
  balance_after_transaction: null,
  category: null,
  payment_method: null,
  extraction_status: "needs_review",
  confidence: 0,
  notes: "Receipt stored for review. Configure OPENAI_API_KEY to autofill fields.",
};

const SYSTEM_PROMPT = `You extract bookkeeping data from fire department receipts.
Return only valid JSON with these keys:
merchant_name, payee, transaction_date, total_amount, tax_amount, category,
payment_method, payment_reference, description, bank_account_name,
balance_after_transaction, confidence, notes.
Prioritize these fields as highest importance:
- merchant_name: read from the top header/store banner first.
- payment_reference: check/check #/auth code/reference/invoice number.
Do not invent values. If unsure, use null.
Use ISO date format YYYY-MM-DD when a date is visible.
Use plain decimal numbers for money without currency symbols.
If a field is not visible, return null for that field.
Set confidence from 0 to 1 based on receipt legibility and certainty.`;

const HEADER_FOCUS_PROMPT = `Return only valid JSON with keys merchant_name and payment_reference.
Read merchant_name from the topmost header/signage text on the receipt.
Read payment_reference from labels like check #, check no, ref, auth, approval, transaction, invoice.
If not visible, return null.`;

function clampConfidence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

async function enrichHeaderFields(
  client: OpenAI,
  dataUrl: string,
  extracted: Partial<ExtractedReceiptData>,
): Promise<Partial<ExtractedReceiptData>> {
  if (extracted.merchant_name && extracted.payment_reference) return extracted;

  try {
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_RECEIPT_MODEL || "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: HEADER_FOCUS_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "Focus on the top of the receipt and reference fields." },
            { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
          ],
        },
      ],
    });
    const headerRaw = response.choices[0]?.message.content || "{}";
    const headerPayload = JSON.parse(headerRaw) as Partial<ExtractedReceiptData>;
    return {
      ...extracted,
      merchant_name: extracted.merchant_name || headerPayload.merchant_name || null,
      payment_reference: extracted.payment_reference || headerPayload.payment_reference || null,
    };
  } catch {
    return extracted;
  }
}

/**
 * Run OCR on an image buffer using OpenAI Vision.
 * Returns ExtractedReceiptData. If no API key is set, returns the fallback.
 */
export async function extractReceiptFromBuffer(
  buffer: Buffer,
  mimeType: string,
): Promise<ExtractedReceiptData> {
  if (!process.env.OPENAI_API_KEY) {
    return FALLBACK_EXTRACTION;
  }

  if (!mimeType.startsWith("image/")) {
    return {
      ...FALLBACK_EXTRACTION,
      notes: "Automatic extraction supports images only. Review PDF fields manually.",
    };
  }

  const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_RECEIPT_MODEL || "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract expense fields from this receipt image. Merchant name must come from top header text when visible.",
            },
            { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
          ],
        },
      ],
    });

    const raw = response.choices[0]?.message.content || "{}";
    const payload = JSON.parse(raw) as Partial<ExtractedReceiptData>;
    const withHeaderFields = await enrichHeaderFields(client, dataUrl, payload);
    const hasRequired = Boolean(
      withHeaderFields.merchant_name &&
        withHeaderFields.transaction_date &&
        withHeaderFields.total_amount,
    );

    return {
      ...FALLBACK_EXTRACTION,
      ...withHeaderFields,
      extraction_status: hasRequired ? "extracted" : "needs_review",
      confidence: clampConfidence(withHeaderFields.confidence),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      ...FALLBACK_EXTRACTION,
      extraction_status: "failed",
      notes: `Automatic extraction failed: ${message}`,
    };
  }
}

/** Parse a total_amount string/number into a float, or null. */
export function parseReceiptAmount(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const n = parseFloat(String(raw).replace(/[$,]/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

/** Compare an OCR-extracted receipt to a known transaction and return a confidence score. */
export function compareReceiptToTransaction({
  ocrAmount,
  ocrVendor,
  ocrDate,
  txAmount,
  txDescription,
  txDate,
}: {
  ocrAmount: number | null;
  ocrVendor: string | null;
  ocrDate: string | null;
  txAmount: number;
  txDescription: string;
  txDate: string;
}): { confidence: number; mismatch: string | null } {
  let score = 0;
  const mismatches: string[] = [];

  // Amount: within 5% or $1, whichever is greater
  if (ocrAmount != null) {
    const tolerance = Math.max(txAmount * 0.05, 1);
    if (Math.abs(ocrAmount - Math.abs(txAmount)) <= tolerance) {
      score += 0.5;
    } else {
      mismatches.push(`Amount mismatch: receipt shows ${ocrAmount}, transaction shows ${txAmount}`);
    }
  }

  // Vendor: loose substring match
  if (ocrVendor) {
    const ocrLower = ocrVendor.toLowerCase();
    const txLower = txDescription.toLowerCase();
    const words = ocrLower.split(/\s+/).filter((w) => w.length > 3);
    const vendorMatch =
      txLower.includes(ocrLower) ||
      ocrLower.includes(txLower) ||
      words.some((w) => txLower.includes(w));
    if (vendorMatch) {
      score += 0.3;
    }
  }

  // Date: within 3 days
  if (ocrDate && txDate) {
    const diff = Math.abs(
      new Date(ocrDate).getTime() - new Date(txDate).getTime(),
    );
    if (diff <= 3 * 86_400_000) {
      score += 0.2;
    } else {
      mismatches.push(`Date mismatch: receipt shows ${ocrDate}, transaction shows ${txDate}`);
    }
  }

  return {
    confidence: Math.min(1, score),
    mismatch: mismatches.length > 0 ? mismatches.join("; ") : null,
  };
}
