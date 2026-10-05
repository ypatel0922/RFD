/**
 * Extraction for incoming-money documents: checks, deposit slips, remittance
 * advice, grant letters, donation letters.
 *
 * Banking details never leave this function. The model is told not to read
 * the MICR line, and every text field is scrubbed of routing/account-like
 * numbers before it is returned, so neither the browser nor the database ever
 * receives them. Failures always return a usable, review-able empty result —
 * extraction must never block recording money.
 */

import OpenAI from "openai";

import { EMPTY_MONEY_IN_EXTRACTION } from "./money-in/extraction-fallback";
import { stripBankNumbers, sanitizeCheckNumber } from "./money-in/sensitive";
import { centsToMoneyString, moneyToCents } from "./tip";
import type { ExtractedMoneyInData, MoneyInDocumentType } from "./types";

export const FALLBACK_MONEY_IN_EXTRACTION: ExtractedMoneyInData = {
  ...EMPTY_MONEY_IN_EXTRACTION,
  notes: "Automatic extraction is not configured. Review the payment details manually.",
};

const DOCUMENT_TYPES: MoneyInDocumentType[] = ["check", "deposit_slip", "remittance", "letter", "other"];
const PAYMENT_METHODS = ["check", "cash", "ach", "wire", "card", "other"];

export const MONEY_IN_SYSTEM_PROMPT = `You read documents that show money paid TO a volunteer fire department: checks, deposit slips, remittance advice, grant award letters, donation letters.
Return strict JSON with these keys:
document_type ("check" | "deposit_slip" | "remittance" | "letter" | "other"),
payer (who the money is FROM — the account holder / organization that wrote the check or sent the payment; never the fire department itself),
amount (numeric amount as a decimal string, e.g. "500.00"; prefer the numeric box, confirm with the written amount),
date (ISO YYYY-MM-DD date written on the document),
check_number (the check number printed in the top-right corner of a check; null if none),
memo (memo / "for" line, or a short purpose line from a letter),
payment_method ("check" | "cash" | "ach" | "wire" | "card" | "other" | null),
fund_designation (any stated restriction or designation, e.g. "2% fund", "building fund", "in memory of …"; null if none),
grant_reference (grant / award / program number if this is a grant; null otherwise),
suggested_category, category_confidence (0-1), category_reason,
suggest_two_percent (true only if the document clearly relates to the NYS foreign fire insurance / 2% distribution),
two_percent_confidence (0-1), two_percent_reason,
confidence (0-1 overall), notes (short note for anything the reviewer should check, or null).

SECURITY — required:
- NEVER return the MICR line, routing number, ABA/transit number, or bank account number, in any field. Ignore the line of numbers along the bottom of a check entirely.
- Do not copy signatures, addresses, phone numbers, or account holder bank details into memo or notes.
Use null for anything not clearly visible.`;

function categoryPromptSection(allowed: string[]): string {
  return `suggested_category MUST be exactly one of these income categories, or null if none fits:
${allowed.map((name) => `- ${name}`).join("\n")}
Never invent a category name. A transfer between the department's own accounts is not a category.`;
}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function matchAllowed(value: unknown, allowed: string[]): string | null {
  if (typeof value !== "string") return null;
  const norm = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (!norm) return null;
  return allowed.find((name) => name.trim().toLowerCase().replace(/\s+/g, " ") === norm) ?? null;
}

function text(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const cleaned = stripBankNumbers(value);
  return cleaned ? cleaned.slice(0, max) : null;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/** Validate and scrub a raw model payload. Exported for tests. */
export function sanitizeMoneyInPayload(
  payload: Record<string, unknown>,
  allowedCategories: string[],
): ExtractedMoneyInData {
  const amountCents = moneyToCents(
    typeof payload.amount === "number" || typeof payload.amount === "string" ? payload.amount : null,
  );
  const amount = amountCents != null && amountCents > 0 ? centsToMoneyString(amountCents) : null;
  const documentType = DOCUMENT_TYPES.includes(payload.document_type as MoneyInDocumentType)
    ? (payload.document_type as MoneyInDocumentType)
    : null;
  const method =
    typeof payload.payment_method === "string" && PAYMENT_METHODS.includes(payload.payment_method)
      ? payload.payment_method
      : documentType === "check"
        ? "check"
        : null;
  const suggested = matchAllowed(payload.suggested_category, allowedCategories);
  const payer = text(payload.payer, 120);
  const date = isoDate(payload.date);
  return {
    document_type: documentType,
    payer,
    amount,
    date,
    check_number: typeof payload.check_number === "string" || typeof payload.check_number === "number"
      ? sanitizeCheckNumber(String(payload.check_number))
      : null,
    memo: text(payload.memo),
    payment_method: method,
    fund_designation: text(payload.fund_designation, 120),
    grant_reference: text(payload.grant_reference, 80),
    suggested_category: suggested,
    category_confidence: suggested ? clampConfidence(payload.category_confidence) : null,
    category_reason: suggested ? text(payload.category_reason) : null,
    suggest_two_percent: payload.suggest_two_percent === true,
    two_percent_confidence: clampConfidence(payload.two_percent_confidence),
    two_percent_reason: text(payload.two_percent_reason),
    extraction_status: payer && amount && date ? "extracted" : "needs_review",
    confidence: clampConfidence(payload.confidence),
    notes: text(payload.notes, 240),
  };
}

export async function extractMoneyInFromBuffer(
  buffer: Buffer,
  mimeType: string,
  options?: { allowedCategories?: string[] },
): Promise<ExtractedMoneyInData> {
  if (!process.env.OPENAI_API_KEY) return FALLBACK_MONEY_IN_EXTRACTION;

  if (!mimeType.startsWith("image/")) {
    return {
      ...FALLBACK_MONEY_IN_EXTRACTION,
      notes: "Automatic extraction supports images only. Enter the payment details from the PDF.",
    };
  }

  const allowed = (options?.allowedCategories || []).map((n) => n.trim()).filter(Boolean).slice(0, 60);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;

  try {
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_RECEIPT_MODEL || "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: allowed.length ? `${MONEY_IN_SYSTEM_PROMPT}\n${categoryPromptSection(allowed)}` : MONEY_IN_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract the incoming payment details from this document." },
            { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
          ],
        },
      ],
    });
    const raw = response.choices[0]?.message.content || "{}";
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return sanitizeMoneyInPayload(parsed, allowed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      ...FALLBACK_MONEY_IN_EXTRACTION,
      extraction_status: "failed",
      notes: `Automatic extraction failed: ${stripBankNumbers(message) ?? "unknown error"}. Review the payment details manually.`,
    };
  }
}
