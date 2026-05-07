import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

import type { ExtractedReceiptData } from "../../../lib/types";

const FALLBACK_EXTRACTION: ExtractedReceiptData = {
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

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const receipt = formData.get("receipt");

  if (!(receipt instanceof File)) {
    return NextResponse.json(
      { ...FALLBACK_EXTRACTION, notes: "Upload a receipt file." },
      { status: 400 },
    );
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(FALLBACK_EXTRACTION);
  }

  if (!receipt.type.startsWith("image/")) {
    return NextResponse.json({
      ...FALLBACK_EXTRACTION,
      notes: "Automatic extraction currently supports receipt images. Review PDF fields manually.",
    });
  }

  const bytes = Buffer.from(await receipt.arrayBuffer());
  const dataUrl = `data:${receipt.type};base64,${bytes.toString("base64")}`;
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
    const withHeaderFields = await enrichHeaderFields({
      client,
      dataUrl,
      extracted: payload,
    });
    const hasRequiredFields = Boolean(
      withHeaderFields.merchant_name && withHeaderFields.transaction_date && withHeaderFields.total_amount,
    );

    return NextResponse.json({
      ...FALLBACK_EXTRACTION,
      ...withHeaderFields,
      extraction_status: hasRequiredFields ? "extracted" : "needs_review",
      confidence: clampConfidence(withHeaderFields.confidence),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown extraction error";
    return NextResponse.json({
      ...FALLBACK_EXTRACTION,
      extraction_status: "failed",
      notes: `Automatic extraction failed: ${message}`,
    });
  }
}

function clampConfidence(value: unknown) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.max(0, Math.min(1, numberValue));
}

async function enrichHeaderFields({
  client,
  dataUrl,
  extracted,
}: {
  client: OpenAI;
  dataUrl: string;
  extracted: Partial<ExtractedReceiptData>;
}) {
  if (extracted.merchant_name && extracted.payment_reference) {
    return extracted;
  }

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
