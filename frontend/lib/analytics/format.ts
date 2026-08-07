/**
 * Display formatting for Analytics.
 *
 * Currency formatting delegates to the reconciliation money helpers so every
 * dollar figure in the product is rendered the same way.
 */

import { absCents, formatCents, type Cents } from "../reconciliation/money";
import { formatDisplayDate, type IsoDate } from "../reconciliation/dates";
import type { PeriodChange, StatusLevel } from "./types";

export { formatCents, formatDisplayDate };

/** Full precision, e.g. `$1,250.50`. */
export function formatMoney(cents: Cents | null | undefined): string {
  return formatCents(cents);
}

/** Whole dollars, for headline figures where cents are noise. */
export function formatMoneyRounded(cents: Cents | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

/** Compact form for chart axes, e.g. `$12.5k`. */
export function formatMoneyCompact(cents: Cents | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  const dollars = cents / 100;
  const magnitude = Math.abs(dollars);
  const sign = dollars < 0 ? "-" : "";
  if (magnitude >= 1_000_000) return `${sign}$${(magnitude / 1_000_000).toFixed(1)}M`;
  if (magnitude >= 1_000) return `${sign}$${(magnitude / 1_000).toFixed(1)}k`;
  return `${sign}$${magnitude.toFixed(0)}`;
}

export function formatSignedMoney(cents: Cents | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  const sign = cents < 0 ? "−" : "+";
  return `${sign}${formatCents(absCents(cents))}`;
}

/**
 * A percentage, or an em dash when the value could not be calculated. Never
 * renders `Infinity` or `NaN`.
 */
export function formatPercent(
  value: number | null | undefined,
  fractionDigits = 0,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(fractionDigits)}%`;
}

export function formatSignedPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "−" : "+";
  return `${sign}${Math.abs(value).toFixed(1)}%`;
}

/**
 * Describe a period-over-period change in words a reader can act on.
 *
 * When there is no comparison period, or the baseline was zero, this says so
 * rather than implying a percentage exists.
 */
export function describeChange(change: PeriodChange): string {
  if (!change.hasComparison) return "No comparison period selected";
  if (change.deltaCents === 0) return "No change from the comparison period";
  if (change.percent == null) {
    const direction = change.deltaCents > 0 ? "up" : "down";
    return `${formatMoney(absCents(change.deltaCents))} ${direction} from nothing in the comparison period`;
  }
  const direction = change.deltaCents > 0 ? "up" : "down";
  return `${formatMoney(absCents(change.deltaCents))} ${direction} (${formatSignedPercent(change.percent)})`;
}

export function formatCount(value: number, singular: string, plural?: string): string {
  const word = value === 1 ? singular : (plural ?? `${singular}s`);
  return `${value.toLocaleString("en-US")} ${word}`;
}

export function formatIsoDate(value: IsoDate | string | null | undefined): string {
  if (!value) return "—";
  return formatDisplayDate(value.slice(0, 10));
}

export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  return formatDisplayDate(value.slice(0, 10));
}

const MONTH_ABBREVIATIONS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Turns a `YYYY-MM` bucket key into an axis label. The year is only shown for
 * January so a twelve-month axis stays readable while still marking where the
 * year turns over.
 */
export function formatMonthLabel(monthKey: string): string {
  const [yearPart, monthPart] = monthKey.split("-");
  const monthIndex = Number(monthPart) - 1;
  const name = MONTH_ABBREVIATIONS[monthIndex];
  if (!name) return monthKey;
  return monthIndex === 0 ? `${name} ${yearPart}` : name;
}

export const STATUS_LABELS: Record<StatusLevel, string> = {
  positive: "Healthy",
  neutral: "Normal",
  attention: "Needs attention",
  risk: "At risk",
  unknown: "Insufficient data",
};

/**
 * The CSS modifier for a status. Colour is always paired with the text label in
 * the UI, never used on its own to carry meaning.
 */
export function statusModifier(level: StatusLevel): string {
  return `fb-an-status--${level}`;
}
