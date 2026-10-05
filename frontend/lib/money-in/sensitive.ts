/**
 * Keeps check banking details out of Hallix data.
 *
 * A photographed check carries the payer's routing and account numbers on the
 * MICR line. Hallix never needs them, so anything that looks like one is
 * stripped before it can be returned by extraction, stored, searched, or shown.
 * The original image stays in private, department-scoped storage.
 */

/** MICR transit / on-us symbols and their common OCR stand-ins. */
const MICR_SYMBOLS = /[⑆⑇⑈⑉]/g;

/** A 9-digit ABA routing number or any long digit run that could be an account number. */
const LONG_DIGIT_RUN = /(?:\d[\s-]?){8,}\d/g;

const BANK_NUMBER_LABEL =
  /\b(?:routing|aba|rtn|transit|account|acct|a\/c)\s*(?:number|no\.?|num|#)?\s*[:#]?\s*[\dX*•\s-]{4,}/gi;

/** Remove routing/account-like numbers from free text. Short numbers (check #, amounts) survive. */
export function stripBankNumbers(value: string | null | undefined): string | null {
  if (value == null) return null;
  const cleaned = String(value)
    .replace(MICR_SYMBOLS, " ")
    .replace(BANK_NUMBER_LABEL, " ")
    .replace(LONG_DIGIT_RUN, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return cleaned || null;
}

/**
 * A check / reference number Hallix may store: up to 8 digits (checks are
 * normally 3–6). Anything longer is treated as banking data and dropped.
 */
export function sanitizeCheckNumber(value: string | null | undefined): string | null {
  const raw = (value || "").trim();
  if (!raw) return null;
  if (/[⑆⑇⑈⑉]/.test(raw)) return null;
  const labelled = raw.match(/(?:check|cheque|chk|ck|ref(?:erence)?)\s*(?:number|num|no\.?|#)?\s*[:#]?\s*([A-Z0-9-]{1,12})/i);
  const candidate = (labelled ? labelled[1] : raw).replace(/^#\s*/, "");
  const digits = candidate.replace(/\D/g, "");
  if (digits.length > 8) return null;
  if (!/^[A-Z0-9-]{1,12}$/i.test(candidate)) return digits && digits.length <= 8 ? digits : null;
  return candidate;
}

/** Last four digits only, for any place an account must be referenced. */
export function maskAccountNumber(value: string | null | undefined): string | null {
  const digits = (value || "").replace(/\D/g, "");
  if (digits.length < 4) return null;
  return `•••• ${digits.slice(-4)}`;
}
