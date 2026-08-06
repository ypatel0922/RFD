/**
 * Decimal-safe currency helpers.
 *
 * Every monetary value in the reconciliation feature is carried as an integer
 * number of cents. Statement totals are summed over hundreds of rows, and
 * float addition drifts (0.1 + 0.2 !== 0.3), which would make a balanced
 * statement look off by a fraction of a cent. Parsing happens once, at the
 * boundary, and all arithmetic afterwards is integer arithmetic.
 */

/** A monetary amount expressed as a whole number of cents. */
export type Cents = number;

const CURRENCY_NOISE = /[$\u00a0\s,]/g;

/**
 * Parse a money value that came from a vision model, a form field, or Postgres
 * `numeric` (which supabase-js returns as a string).
 *
 * Handles `1,234.56`, `$1,234.56`, `(1,234.56)` and `1234.56-` as negatives,
 * bare integers, and values written with a trailing `CR`/`DR` marker. Returns
 * null for anything it cannot read confidently rather than guessing a number.
 */
export function parseCents(value: unknown): Cents | null {
  if (value == null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Math.round(value * 100);
  }
  if (typeof value !== "string") return null;

  let text = value.trim();
  if (!text) return null;

  let negative = false;

  // Accounting parentheses: (45.00) means -45.00
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }

  // Trailing or leading credit/debit markers used by some statement layouts.
  const marker = text.match(/(^|\s)(CR|DR)\s*$/i);
  if (marker) {
    if (marker[2].toUpperCase() === "DR") negative = true;
    text = text.slice(0, marker.index).trim();
  }

  // Trailing minus: 45.00-
  if (/-\s*$/.test(text)) {
    negative = true;
    text = text.replace(/-\s*$/, "");
  }

  text = text.replace(CURRENCY_NOISE, "");
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }

  if (!/^\d*\.?\d*$/.test(text) || !/\d/.test(text)) return null;

  const [wholePart, fractionPart = ""] = text.split(".");
  // More than two decimal places is not a currency amount we should trust.
  if (fractionPart.length > 2) return null;

  const whole = wholePart === "" ? 0 : Number(wholePart);
  const fraction = Number((fractionPart + "00").slice(0, 2));
  if (!Number.isFinite(whole) || !Number.isFinite(fraction)) return null;

  const cents = whole * 100 + fraction;
  return negative ? -cents : cents;
}

/** Convert cents back to the `numeric(12,2)` shape Postgres expects. */
export function centsToNumeric(cents: Cents | null | undefined): number | null {
  if (cents == null || !Number.isFinite(cents)) return null;
  return Math.round(cents) / 100;
}

/** Sum cents without intermediate float error. */
export function sumCents(values: Array<Cents | null | undefined>): Cents {
  let total = 0;
  for (const value of values) {
    if (value == null || !Number.isFinite(value)) continue;
    total += Math.round(value);
  }
  return total;
}

export function absCents(cents: Cents): Cents {
  return cents < 0 ? -cents : cents;
}

/** Format cents for display, e.g. -125050 -> "-$1,250.50". */
export function formatCents(cents: Cents | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return formatter.format(cents / 100);
}

/** Format cents with an explicit sign, e.g. +$40.00 / -$40.00. */
export function formatSignedCents(cents: Cents | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  const sign = cents < 0 ? "-" : "+";
  return `${sign}${formatCents(absCents(cents)).replace("-", "")}`;
}
