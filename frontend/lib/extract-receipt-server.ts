/**
 * Server-only receipt OCR helper.
 * Shared between the /api/extract-receipt HTTP route and the Twilio inbound webhook.
 * Never import in client components.
 */
import OpenAI from "openai";

import { centsToMoneyString, moneyToCents, reconcileReceiptAmounts } from "./tip";
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
  line_items: null,
  suggested_category: null,
  category_confidence: null,
  category_reason: null,
  suggest_two_percent: null,
  two_percent_confidence: null,
  subtotal_amount: null,
  base_amount: null,
  tip_amount: null,
  gratuity_included_in_total: null,
};

const SYSTEM_PROMPT = `You extract bookkeeping data from fire department receipts.
Return only valid JSON with these keys:
merchant_name, payee, transaction_date, subtotal_amount, tax_amount,
base_amount, tip_amount, total_amount, gratuity_included_in_total, category,
payment_method, payment_reference, description, bank_account_name,
balance_after_transaction, line_items, confidence, notes.
Prioritize these fields as highest importance:
- merchant_name: read from the top header/store banner first.
- payment_reference: check/check #/auth code/reference/invoice number.
line_items must be an array of short purchased-item descriptions, or null.
Do not invent values. If unsure, use null.
Use ISO date format YYYY-MM-DD when a date is visible.
Use plain decimal numbers for money without currency symbols.
If a field is not visible, return null for that field.
Set confidence from 0 to 1 based on receipt legibility and certainty.

Amounts — read these as five distinct concepts:
- subtotal_amount: the PRE-TAX subtotal of the items.
- tax_amount: sales tax. Recognize labels such as Tax, Sales Tax, NY Tax,
  NYS Tax, State Tax, Local Tax, and Tax Amount. An amount printed on or
  beside a tax label is tax.
- base_amount: the PRINTED receipt total BEFORE any tip. It already INCLUDES
  tax, so base_amount = subtotal_amount + tax_amount. Never put the pre-tax
  subtotal in base_amount.
- tip_amount: a voluntary gratuity, usually HANDWRITTEN on a tip line.
- total_amount: the final amount paid, including any tip.

Do not classify tax as tip. A difference between the subtotal and the total is
usually tax unless the receipt separately indicates gratuity or tip. Only
populate tip_amount when there is explicit tip/gratuity evidence, or a clearly
handwritten final total above the printed pre-tip total.

Worked example — subtotal 85.00, Tax 5.95, Total 90.95, nothing handwritten:
  subtotal_amount 85.00, tax_amount 5.95, base_amount 90.95,
  tip_amount null, total_amount 90.95.
The 5.95 is tax and must NOT appear as tip_amount.

Worked example — the same receipt with a handwritten Tip 18.00 and a
handwritten total 108.95:
  subtotal_amount 85.00, tax_amount 5.95, base_amount 90.95,
  tip_amount 18.00, total_amount 108.95.

Inspect handwritten digits on "Tip", "Gratuity", and "Total" lines. If the
handwriting is unclear or ambiguous, return null for tip_amount rather than
guessing. Never invent a tip. If you cannot tell whether an amount is tax or a
tip, treat it as tax and leave tip_amount null.
If the receipt shows a printed service charge, mandatory gratuity, or automatic
gratuity that is ALREADY part of the printed total, set
gratuity_included_in_total to true and leave tip_amount null so it is not
counted twice. Otherwise set gratuity_included_in_total to false.`;

/**
 * Appended to the extraction prompt when the caller supplies the department's
 * category list, so classification rides along in the same request.
 */
function categoryPromptSection(allowedCategories: string[]): string {
  return `
Also classify the expense for a New York volunteer fire department.
Add these keys to the same JSON object:
suggested_category, category_confidence, category_reason,
suggest_two_percent, two_percent_confidence.
suggested_category MUST be copied exactly from this list, or null when none fit:
${allowedCategories.map((name) => `- ${name}`).join("\n")}
Never invent a category name that is not in the list.
Prefer what the purchased line items show over a generic assumption from the
store name. A hardware store receipt for lumber and drywall is building
maintenance; the same store selling cleaning supplies is not.
category_confidence and two_percent_confidence are numbers from 0 to 1.
category_reason is one short sentence.
suggest_two_percent is true only when the purchase looks like member-benefit
spending commonly paid from NYS 2% foreign fire insurance funds (member food,
member events, dress/parade uniforms, member room furnishings, member
insurance, department newsletter). It is a recommendation, not a legal
determination. Use false when unsure.`;
}

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

function normalizeLineItems(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean)
    .slice(0, 25);
  return items.length > 0 ? items : null;
}

/**
 * Keep only a category the department actually has. A model that returns an
 * unknown name yields no suggestion rather than a invented category.
 */
function matchAllowedCategory(
  value: unknown,
  allowedCategories: string[],
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized || normalized === "uncategorized") return null;
  return (
    allowedCategories.find(
      (name) => name.trim().toLowerCase().replace(/\s+/g, " ") === normalized,
    ) ?? null
  );
}

/** Strip classification output that is unusable so callers can fall back. */
function sanitizeClassification(
  payload: Partial<ExtractedReceiptData>,
  allowedCategories: string[],
): Partial<ExtractedReceiptData> {
  const suggested = matchAllowedCategory(payload.suggested_category, allowedCategories);
  const reason =
    typeof payload.category_reason === "string" ? payload.category_reason.slice(0, 200) : null;
  return {
    line_items: normalizeLineItems(payload.line_items),
    suggested_category: suggested,
    category_confidence: suggested ? clampConfidence(payload.category_confidence) : null,
    category_reason: suggested ? reason : null,
    suggest_two_percent: payload.suggest_two_percent === true,
    two_percent_confidence: clampConfidence(payload.two_percent_confidence),
  };
}

/** Normalize a money field to a plain decimal string, or null when unreadable. */
function normalizeMoneyField(value: unknown): string | null {
  const cents = moneyToCents(
    typeof value === "number" || typeof value === "string" ? value : null,
  );
  if (cents == null || cents <= 0) return null;
  return centsToMoneyString(cents);
}

/**
 * Resolve subtotal, tax, pre-tip total, tip, and final total from the model's
 * reading, so sales tax is never mistaken for a tip and a real handwritten tip
 * is neither lost nor double counted.
 */
function sanitizeAmounts(payload: Partial<ExtractedReceiptData>): Partial<ExtractedReceiptData> {
  const gratuityIncluded = payload.gratuity_included_in_total === true;
  const amounts = reconcileReceiptAmounts({
    subtotalCents: moneyToCents(normalizeMoneyField(payload.subtotal_amount)),
    taxCents: moneyToCents(normalizeMoneyField(payload.tax_amount)),
    baseCents: moneyToCents(normalizeMoneyField(payload.base_amount)),
    // A printed service charge already sits inside the total; adding it again
    // would overstate the expense.
    tipCents: gratuityIncluded ? null : moneyToCents(normalizeMoneyField(payload.tip_amount)),
    totalCents: moneyToCents(normalizeMoneyField(payload.total_amount)),
  });

  const tax = centsToMoneyString(amounts.taxCents) || null;
  const subtotal = centsToMoneyString(amounts.subtotalCents) || null;

  if (amounts.totalCents <= 0) {
    return {
      subtotal_amount: subtotal,
      tax_amount: tax,
      base_amount: null,
      tip_amount: null,
      total_amount: null,
      gratuity_included_in_total: gratuityIncluded,
    };
  }

  return {
    subtotal_amount: subtotal,
    tax_amount: tax,
    base_amount: centsToMoneyString(amounts.baseCents) || null,
    tip_amount: centsToMoneyString(amounts.tipCents) || null,
    total_amount: centsToMoneyString(amounts.totalCents) || null,
    gratuity_included_in_total: gratuityIncluded,
  };
}

/**
 * Run OCR on an image buffer using OpenAI Vision.
 * Returns ExtractedReceiptData. If no API key is set, returns the fallback.
 *
 * When `allowedCategories` is supplied, the same request also classifies the
 * expense and flags possible 2% fund spending — no extra model call is made.
 * Classification problems never fail extraction; they just yield no suggestion.
 */
export async function extractReceiptFromBuffer(
  buffer: Buffer,
  mimeType: string,
  options?: { allowedCategories?: string[] },
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

  const allowedCategories = (options?.allowedCategories || [])
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, 80);

  const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_RECEIPT_MODEL || "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            allowedCategories.length > 0
              ? `${SYSTEM_PROMPT}\n${categoryPromptSection(allowedCategories)}`
              : SYSTEM_PROMPT,
        },
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
    const amounts = sanitizeAmounts(withHeaderFields);
    const hasRequired = Boolean(
      withHeaderFields.merchant_name && withHeaderFields.transaction_date && amounts.total_amount,
    );

    return {
      ...FALLBACK_EXTRACTION,
      ...withHeaderFields,
      ...sanitizeClassification(withHeaderFields, allowedCategories),
      ...amounts,
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
