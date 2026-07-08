/**
 * Server-only Twilio helpers for SMS/MMS receipt collection.
 * Never import this module in client components.
 */
import crypto from "crypto";

export interface SendSmsParams {
  to: string;
  body: string;
}

export interface SendSmsResult {
  sid: string;
  status: string;
}

function twilioCredentials() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set.");
  }
  return { accountSid, authToken };
}

function twilioFrom(): string {
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  if (!messagingServiceSid && !fromNumber) {
    throw new Error(
      "Set TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER.",
    );
  }
  return messagingServiceSid || fromNumber!;
}

/** Send an SMS/MMS via the Twilio REST API (no SDK required). */
export async function sendSms({ to, body }: SendSmsParams): Promise<SendSmsResult> {
  const { accountSid, authToken } = twilioCredentials();
  const from = twilioFrom();

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const params = new URLSearchParams({ To: to, Body: body });

  const isMessagingService = from.startsWith("MG");
  if (isMessagingService) {
    params.set("MessagingServiceSid", from);
  } else {
    params.set("From", from);
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Twilio error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as { sid: string; status: string };
  return { sid: data.sid, status: data.status };
}

/** Download media from a Twilio MediaUrl using basic auth. */
export async function downloadTwilioMedia(mediaUrl: string): Promise<{ buffer: Buffer; contentType: string }> {
  const { accountSid, authToken } = twilioCredentials();

  const response = await fetch(mediaUrl, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download media ${response.status}: ${mediaUrl}`);
  }

  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const arrayBuffer = await response.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), contentType };
}

/**
 * Validate a Twilio webhook signature.
 * Returns true if the signature is valid or if validation is disabled.
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function validateTwilioSignature(
  signature: string | null,
  url: string,
  params: Record<string, string>,
): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return false;
  if (!signature) return false;

  // Build the validation string: URL + sorted key/value pairs
  const sortedKeys = Object.keys(params).sort();
  const str = url + sortedKeys.map((k) => k + params[k]).join("");

  const expected = crypto
    .createHmac("sha1", authToken)
    .update(str, "utf8")
    .digest("base64");

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/** Generate a short human-readable request code, e.g. FB-8392. */
export function generateRequestCode(): string {
  const digits = Math.floor(1000 + Math.random() * 9000);
  return `FB-${digits}`;
}

/** Normalize a phone number to E.164 format for storage and comparison. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.startsWith("+")) return raw.replace(/[^\d+]/g, "");
  return `+${digits}`;
}

/** Check if two phone numbers represent the same number (normalized comparison). */
export function phonesMatch(a: string, b: string): boolean {
  return normalizePhone(a) === normalizePhone(b);
}

/** Format an amount as a currency string for SMS messages. */
export function formatAmountForSms(amount: number | string | null | undefined): string {
  if (amount == null) return "unknown amount";
  const n = typeof amount === "number" ? amount : parseFloat(String(amount).replace(/[$,]/g, ""));
  if (!Number.isFinite(n)) return "unknown amount";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Math.abs(n));
}

/** Build the outbound receipt request SMS message. */
export function buildReceiptRequestMessage({
  amount,
  vendor,
  date,
  requestCode,
}: {
  amount: number | string | null;
  vendor: string;
  date: string;
  requestCode: string;
}): string {
  const baseUrl = process.env.APP_BASE_URL;
  const amountStr = formatAmountForSms(amount);
  const link = baseUrl ? ` ${baseUrl}/receipt-request/${requestCode}` : "";
  return (
    `Firebook: Receipt needed for ${amountStr} at ${vendor} on ${date}.` +
    ` Reply with a photo of the receipt.` +
    ` Ref: ${requestCode}${link}`
  );
}

/** Build the success confirmation SMS. */
export function buildReceiptConfirmationMessage({
  vendor,
  amount,
}: {
  vendor: string;
  amount: number | string | null;
}): string {
  const amountStr = formatAmountForSms(amount);
  return `Firebook received the receipt for ${vendor} ${amountStr}. You're all set.`;
}

/** Build the "needs reference code" reply when multiple pending requests exist. */
export function buildAmbiguousReceiptMessage(): string {
  return (
    "Firebook received your receipt, but I could not tell which transaction it belongs to. " +
    "Reply with the reference code from the original message (e.g. FB-1234)."
  );
}

/** Build the "no media found" reply. */
export function buildNoMediaMessage(): string {
  return "Please reply with a photo of the receipt.";
}

/** Build a TwiML response body string. */
export function buildTwimlResponse(message: string): string {
  const escaped = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
}

/** Heuristic: skip receipt requests for transfers and bank interest. */
export function isTransferOrInterestDescription(description: string): boolean {
  const lower = description.toLowerCase();
  const patterns = [
    "transfer",
    "wire",
    "interest earned",
    "interest payment",
    "dividend",
    "payroll",
    "direct deposit",
    "ach deposit",
    "atm deposit",
    "check deposit",
    "zelle",
    "venmo",
    "cashback",
    "cash back",
    "refund",
    "credit adjustment",
  ];
  return patterns.some((p) => lower.includes(p));
}

/** Determine if a receipt path represents a "no receipt" placeholder. */
export function isMissingReceiptPath(path: string | null | undefined): boolean {
  if (!path) return true;
  const lower = path.toLowerCase();
  return lower.includes("no-receipt") || lower.includes("/manual/") || lower.includes("/statement-import/");
}
