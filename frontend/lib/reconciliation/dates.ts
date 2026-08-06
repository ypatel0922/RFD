/**
 * Date helpers for statement reconciliation.
 *
 * All dates are handled as plain `YYYY-MM-DD` calendar strings and compared as
 * UTC midnights. Statement dates have no time-of-day, and using local Date
 * parsing would shift a posting date across a day boundary depending on the
 * treasurer's timezone.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/** A plain calendar date in `YYYY-MM-DD` form. */
export type IsoDate = string;

export function isIsoDate(value: unknown): value is IsoDate {
  return typeof value === "string" && ISO_DATE.test(value) && toUtcMillis(value) != null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Normalize a date a vision model may return in any common US statement format.
 * Two-digit years are resolved against a reference year so a statement covering
 * a December/January boundary lands in the right year.
 */
export function normalizeStatementDate(
  value: unknown,
  referenceYear?: number,
): IsoDate | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;

  const isoMatch = text.match(ISO_DATE);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > daysInMonth(year, month)) return null;
    return text;
  }

  // MM/DD, MM/DD/YY, MM/DD/YYYY, MM-DD-YYYY
  const slash = text.match(/^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2}|\d{4}))?$/);
  if (slash) {
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    let year: number;
    if (slash[3]) {
      year = Number(slash[3]);
      if (slash[3].length === 2) year += year >= 70 ? 1900 : 2000;
    } else if (referenceYear) {
      year = referenceYear;
    } else {
      return null;
    }
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > daysInMonth(year, month)) return null;
    return isoFrom(year, month, day);
  }

  // Statement headers usually spell the period out: "March 14, 2025" or
  // "14 Mar 2025".
  const spelled =
    text.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i) ??
    reverse(text.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?,?\s+(\d{4})$/i));
  if (spelled) {
    const month = MONTH_NAMES[spelled[1].toLowerCase()];
    const day = Number(spelled[2]);
    const year = Number(spelled[3]);
    if (!month) return null;
    if (day < 1 || day > daysInMonth(year, month)) return null;
    return isoFrom(year, month, day);
  }

  return null;
}

/** Swap the day and month captures so both spelled-out orders share a branch. */
function reverse(match: RegExpMatchArray | null): RegExpMatchArray | null {
  if (!match) return null;
  const swapped = [match[0], match[2], match[1], match[3]] as unknown as RegExpMatchArray;
  return swapped;
}

function isoFrom(year: number, month: number, day: number): IsoDate {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function toUtcMillis(date: IsoDate | null | undefined): number | null {
  if (!date) return null;
  const match = date.match(ISO_DATE);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const millis = Date.UTC(year, month - 1, day);
  const parsed = new Date(millis);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return millis;
}

/**
 * Whole calendar days of `left` minus `right`, or null when either is
 * unreadable. Positive means `left` is the later date, which is how the matching
 * engine phrases "posted N days after the Hallix date".
 */
export function daysBetween(
  left: IsoDate | null | undefined,
  right: IsoDate | null | undefined,
): number | null {
  const a = toUtcMillis(left);
  const b = toUtcMillis(right);
  if (a == null || b == null) return null;
  return Math.round((a - b) / 86_400_000);
}

export function absDaysBetween(
  left: IsoDate | null | undefined,
  right: IsoDate | null | undefined,
): number | null {
  const diff = daysBetween(left, right);
  return diff == null ? null : Math.abs(diff);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const millis = toUtcMillis(date);
  if (millis == null) return date;
  const shifted = new Date(millis + days * 86_400_000);
  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    String(shifted.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function isWithinPeriod(
  date: IsoDate | null | undefined,
  start: IsoDate | null | undefined,
  end: IsoDate | null | undefined,
): boolean {
  const value = toUtcMillis(date);
  if (value == null) return false;
  const from = toUtcMillis(start);
  const to = toUtcMillis(end);
  if (from != null && value < from) return false;
  if (to != null && value > to) return false;
  return true;
}

/** True when two `[start, end]` ranges share at least one day. */
export function periodsOverlap(
  aStart: IsoDate | null | undefined,
  aEnd: IsoDate | null | undefined,
  bStart: IsoDate | null | undefined,
  bEnd: IsoDate | null | undefined,
): boolean {
  const a1 = toUtcMillis(aStart);
  const a2 = toUtcMillis(aEnd);
  const b1 = toUtcMillis(bStart);
  const b2 = toUtcMillis(bEnd);
  if (a1 == null || a2 == null || b1 == null || b2 == null) return false;
  return a1 <= b2 && b1 <= a2;
}

export function formatDisplayDate(date: IsoDate | null | undefined): string {
  const millis = toUtcMillis(date ?? null);
  if (millis == null) return "—";
  return new Date(millis).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatPeriod(
  start: IsoDate | null | undefined,
  end: IsoDate | null | undefined,
): string {
  if (!start && !end) return "Statement period not read";
  return `${formatDisplayDate(start)} – ${formatDisplayDate(end)}`;
}
