/**
 * Date range and comparison-period arithmetic for Analytics.
 *
 * Ranges are inclusive on both ends and expressed as `YYYY-MM-DD` calendar
 * strings, matching `expenses.transaction_date`. All arithmetic runs in UTC via
 * the reconciliation date helpers so a range never shifts by a day depending on
 * the treasurer's timezone, and so December/January boundaries land in the
 * correct year.
 */

import { addDays, isIsoDate, toUtcMillis, type IsoDate } from "../reconciliation/dates";
import type {
  AnalyticsPeriod,
  ComparisonModeId,
  DateRange,
  DateRangePresetId,
} from "./types";

export const DATE_RANGE_PRESETS: Array<{ id: DateRangePresetId; label: string }> = [
  { id: "this_month", label: "This month" },
  { id: "this_quarter", label: "This quarter" },
  { id: "year_to_date", label: "Year to date" },
  { id: "last_12_months", label: "Last 12 months" },
  { id: "prior_calendar_year", label: "Prior calendar year" },
  { id: "custom", label: "Custom range" },
];

export const COMPARISON_MODES: Array<{ id: ComparisonModeId; label: string }> = [
  { id: "previous_period", label: "Previous period" },
  { id: "same_period_last_year", label: "Same period last year" },
  { id: "none", label: "No comparison" },
];

export const DEFAULT_PRESET: DateRangePresetId = "year_to_date";
export const DEFAULT_COMPARISON: ComparisonModeId = "previous_period";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function isoFromParts(year: number, month: number, day: number): IsoDate {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Days in a calendar month, where `month` is 1-based. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function startOfMonth(date: IsoDate): IsoDate {
  const [year, month] = splitIso(date);
  return isoFromParts(year, month, 1);
}

export function endOfMonth(date: IsoDate): IsoDate {
  const [year, month] = splitIso(date);
  return isoFromParts(year, month, daysInMonth(year, month));
}

function splitIso(date: IsoDate): [number, number, number] {
  const [y, m, d] = date.split("-");
  return [Number(y), Number(m), Number(d)];
}

/** Today as a calendar date in the viewer's local timezone. */
export function todayIso(now: Date = new Date()): IsoDate {
  return isoFromParts(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/**
 * Shift a date by whole months, clamping the day to the target month's length
 * so 31 March minus one month is 28 February rather than an invalid date.
 */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const [year, month, day] = splitIso(date);
  const zeroBased = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(zeroBased / 12);
  const targetMonth = (zeroBased % 12) + 1;
  const clampedDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return isoFromParts(targetYear, targetMonth, clampedDay);
}

export function addYears(date: IsoDate, years: number): IsoDate {
  return addMonths(date, years * 12);
}

/** Inclusive day count, so a single-day range has length 1. */
export function rangeLengthInDays(range: DateRange): number {
  const start = toUtcMillis(range.start);
  const end = toUtcMillis(range.end);
  if (start == null || end == null) return 0;
  return Math.round((end - start) / 86_400_000) + 1;
}

export function rangeContains(range: DateRange, date: IsoDate | null | undefined): boolean {
  if (!date) return false;
  const value = toUtcMillis(date);
  const start = toUtcMillis(range.start);
  const end = toUtcMillis(range.end);
  if (value == null || start == null || end == null) return false;
  return value >= start && value <= end;
}

/** Build a range from a preset. `custom` falls back to the supplied range. */
export function rangeForPreset(
  preset: DateRangePresetId,
  options: { today?: IsoDate; custom?: DateRange | null } = {},
): DateRange {
  const today = options.today ?? todayIso();
  const [year, month] = splitIso(today);

  switch (preset) {
    case "this_month":
      return { start: startOfMonth(today), end: endOfMonth(today) };

    case "this_quarter": {
      const quarterStartMonth = Math.floor((month - 1) / 3) * 3 + 1;
      const quarterEndMonth = quarterStartMonth + 2;
      return {
        start: isoFromParts(year, quarterStartMonth, 1),
        end: isoFromParts(year, quarterEndMonth, daysInMonth(year, quarterEndMonth)),
      };
    }

    case "year_to_date":
      return { start: isoFromParts(year, 1, 1), end: today };

    case "last_12_months":
      // 12 whole months ending today, e.g. 2025-03-15 covers 2024-03-16 onward.
      return { start: addDays(addYears(today, -1), 1), end: today };

    case "prior_calendar_year":
      return { start: isoFromParts(year - 1, 1, 1), end: isoFromParts(year - 1, 12, 31) };

    case "custom":
      return options.custom && isValidRange(options.custom)
        ? options.custom
        : { start: isoFromParts(year, 1, 1), end: today };
  }
}

export function isValidRange(range: DateRange | null | undefined): range is DateRange {
  if (!range) return false;
  if (!isIsoDate(range.start) || !isIsoDate(range.end)) return false;
  const start = toUtcMillis(range.start);
  const end = toUtcMillis(range.end);
  return start != null && end != null && start <= end;
}

/**
 * The range a period is compared against.
 *
 * `previous_period` uses the immediately preceding window of the same length,
 * so a 30-day range compares against the 30 days before it. `same_period_last_year`
 * shifts by a calendar year, which keeps seasonal comparisons aligned.
 */
export function comparisonRange(
  range: DateRange,
  mode: ComparisonModeId,
): DateRange | null {
  if (mode === "none") return null;
  if (!isValidRange(range)) return null;

  if (mode === "same_period_last_year") {
    return { start: addYears(range.start, -1), end: addYears(range.end, -1) };
  }

  const length = rangeLengthInDays(range);
  if (length <= 0) return null;
  const end = addDays(range.start, -1);
  const start = addDays(end, -(length - 1));
  return { start, end };
}

export function formatRangeLabel(range: DateRange): string {
  const start = toUtcMillis(range.start);
  const end = toUtcMillis(range.end);
  if (start == null || end == null) return "Select a date range";

  const startDate = new Date(start);
  const endDate = new Date(end);
  const sameYear = startDate.getUTCFullYear() === endDate.getUTCFullYear();

  const startText = startDate.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    timeZone: "UTC",
  });
  const endText = endDate.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return `${startText} – ${endText}`;
}

export function buildPeriod(options: {
  preset: DateRangePresetId;
  comparisonMode: ComparisonModeId;
  custom?: DateRange | null;
  today?: IsoDate;
}): AnalyticsPeriod {
  const range = rangeForPreset(options.preset, {
    today: options.today,
    custom: options.custom,
  });
  const comparison = comparisonRange(range, options.comparisonMode);
  const presetLabel =
    DATE_RANGE_PRESETS.find((preset) => preset.id === options.preset)?.label ?? "Custom range";

  return {
    range,
    preset: options.preset,
    label: options.preset === "custom" ? formatRangeLabel(range) : presetLabel,
    comparison,
    comparisonMode: options.comparisonMode,
    comparisonLabel: comparison ? formatRangeLabel(comparison) : null,
  };
}

/**
 * The earliest date any calculation needs, so the data layer can fetch one
 * bounded window instead of a department's entire history. Trends look back 12
 * months from the range start, and comparisons can reach back a further year.
 */
export function earliestNeededDate(period: AnalyticsPeriod): IsoDate {
  const candidates: IsoDate[] = [addMonths(period.range.start, -12)];
  if (period.comparison) candidates.push(addMonths(period.comparison.start, -12));
  // Year-to-date 2% figures always need 1 January of the range's year.
  const [year] = splitIso(period.range.start);
  candidates.push(isoFromParts(year - 1, 1, 1));

  return candidates.reduce((earliest, candidate) =>
    (toUtcMillis(candidate) ?? 0) < (toUtcMillis(earliest) ?? 0) ? candidate : earliest,
  );
}

/** The `YYYY-MM` bucket a date belongs to, used for every monthly trend. */
export function monthKey(date: IsoDate): string {
  return date.slice(0, 7);
}

export function monthLabel(key: string): string {
  const millis = toUtcMillis(`${key}-01`);
  if (millis == null) return key;
  return new Date(millis).toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
}

/** Every `YYYY-MM` bucket the range touches, in order, including empty ones. */
export function monthKeysInRange(range: DateRange): string[] {
  if (!isValidRange(range)) return [];
  const keys: string[] = [];
  let cursor = startOfMonth(range.start);
  const last = startOfMonth(range.end);
  // Ranges are user-selected; the cap stops a malformed range from spinning.
  for (let guard = 0; guard < 600; guard += 1) {
    keys.push(monthKey(cursor));
    if (cursor === last) break;
    cursor = addMonths(cursor, 1);
  }
  return keys;
}
