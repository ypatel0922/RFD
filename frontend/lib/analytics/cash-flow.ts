/**
 * Cash-flow history and a deliberately modest outlook.
 *
 * The forecast is a straight average of recent months, nothing cleverer. That
 * is honest about what the data supports: a volunteer department's ledger has
 * no recurring-transaction schedule to project from, so anything more elaborate
 * would look precise without being more accurate.
 *
 * When there is not enough history the forecast is withheld entirely rather
 * than extrapolated from one or two months.
 */

import type { Cents } from "../reconciliation/money";
import type { IsoDate } from "../reconciliation/dates";
import { addMonths, monthKey, monthLabel, todayIso } from "./date-range";
import type { AnalyticsTransaction, StatusLevel } from "./types";

/** Months of history required before any outlook is offered. */
export const MIN_MONTHS_FOR_FORECAST = 3;

export type CashFlowMonth = {
  monthKey: string;
  label: string;
  inflowCents: Cents;
  outflowCents: Cents;
  netCents: Cents;
  /** Running balance when a starting balance is known, otherwise null. */
  balanceCents: Cents | null;
};

export type CashFlowOutlook = {
  available: boolean;
  /** Why an outlook could not be produced, for the empty state. */
  unavailableReason: string | null;
  monthsOfHistory: number;
  averageMonthlyNetCents: Cents;
  averageMonthlyOutflowCents: Cents;
  currentBalanceCents: Cents | null;
  projections: Array<{ horizonDays: 30 | 60 | 90; projectedBalanceCents: Cents | null }>;
  basis: string;
  runwayStatus: { level: StatusLevel; label: string; explanation: string } | null;
};

export type CashFlowSummary = {
  months: CashFlowMonth[];
  outlook: CashFlowOutlook;
};

export function summarizeCashFlow(options: {
  transactions: AnalyticsTransaction[];
  monthsOfHistory?: number;
  currentBalanceCents?: Cents | null;
  today?: IsoDate;
}): CashFlowSummary {
  const today = options.today ?? todayIso();
  const windowMonths = options.monthsOfHistory ?? 12;

  const keys: string[] = [];
  for (let offset = windowMonths - 1; offset >= 0; offset -= 1) {
    keys.push(monthKey(addMonths(today, -offset)));
  }

  const buckets = new Map<string, { inflow: Cents; outflow: Cents }>();
  for (const key of keys) buckets.set(key, { inflow: 0, outflow: 0 });

  for (const transaction of options.transactions) {
    if (!transaction.date) continue;
    const bucket = buckets.get(monthKey(transaction.date));
    if (!bucket) continue;
    switch (transaction.classification) {
      case "income":
        bucket.inflow += transaction.magnitudeCents;
        break;
      case "expense":
        bucket.outflow += transaction.magnitudeCents;
        break;
      case "refund":
        bucket.outflow -= transaction.magnitudeCents;
        break;
      // Transfers and card payments move money the department already has, so
      // they would show as both an inflow and an outflow of the same dollars.
      case "internal_transfer":
      case "credit_card_payment":
        break;
    }
  }

  const currentBalance = options.currentBalanceCents ?? null;

  // Walk backwards from today's balance so each month shows the balance as it
  // stood at that month's close.
  const months: CashFlowMonth[] = keys.map((key) => {
    const bucket = buckets.get(key) ?? { inflow: 0, outflow: 0 };
    return {
      monthKey: key,
      label: monthLabel(key),
      inflowCents: bucket.inflow,
      outflowCents: bucket.outflow,
      netCents: bucket.inflow - bucket.outflow,
      balanceCents: null,
    };
  });

  if (currentBalance != null) {
    let running = currentBalance;
    for (let index = months.length - 1; index >= 0; index -= 1) {
      months[index].balanceCents = running;
      running -= months[index].netCents;
    }
  }

  return {
    months,
    outlook: buildOutlook({ months, currentBalanceCents: currentBalance }),
  };
}

function buildOutlook(options: {
  months: CashFlowMonth[];
  currentBalanceCents: Cents | null;
}): CashFlowOutlook {
  const active = options.months.filter(
    (month) => month.inflowCents !== 0 || month.outflowCents !== 0,
  );
  const monthsOfHistory = active.length;

  const emptyProjections = [30, 60, 90].map((horizonDays) => ({
    horizonDays: horizonDays as 30 | 60 | 90,
    projectedBalanceCents: null,
  }));

  if (monthsOfHistory < MIN_MONTHS_FOR_FORECAST) {
    return {
      available: false,
      unavailableReason: `An outlook needs at least ${MIN_MONTHS_FOR_FORECAST} months of recorded activity. Hallix has ${monthsOfHistory}.`,
      monthsOfHistory,
      averageMonthlyNetCents: 0,
      averageMonthlyOutflowCents: 0,
      currentBalanceCents: options.currentBalanceCents,
      projections: emptyProjections,
      basis: "",
      runwayStatus: null,
    };
  }

  const averageMonthlyNetCents = Math.round(
    active.reduce((sum, month) => sum + month.netCents, 0) / monthsOfHistory,
  );
  const averageMonthlyOutflowCents = Math.round(
    active.reduce((sum, month) => sum + month.outflowCents, 0) / monthsOfHistory,
  );

  if (options.currentBalanceCents == null) {
    return {
      available: false,
      unavailableReason:
        "An outlook needs a current cash balance. Record an opening balance or reconcile an account to establish one.",
      monthsOfHistory,
      averageMonthlyNetCents,
      averageMonthlyOutflowCents,
      currentBalanceCents: null,
      projections: emptyProjections,
      basis: "",
      runwayStatus: null,
    };
  }

  const balance = options.currentBalanceCents;
  const projections = ([30, 60, 90] as const).map((horizonDays) => ({
    horizonDays,
    projectedBalanceCents: balance + Math.round((averageMonthlyNetCents * horizonDays) / 30),
  }));

  return {
    available: true,
    unavailableReason: null,
    monthsOfHistory,
    averageMonthlyNetCents,
    averageMonthlyOutflowCents,
    currentBalanceCents: balance,
    projections,
    basis: `Estimated by carrying the average monthly net change from the last ${monthsOfHistory} months forward. It assumes spending continues at the same pace and does not know about planned purchases.`,
    runwayStatus: runwayStatus(balance, averageMonthlyOutflowCents),
  };
}

function runwayStatus(
  balanceCents: Cents,
  averageMonthlyOutflowCents: Cents,
): { level: StatusLevel; label: string; explanation: string } | null {
  if (averageMonthlyOutflowCents <= 0) return null;
  const months = balanceCents / averageMonthlyOutflowCents;

  if (months < 1) {
    return {
      level: "risk",
      label: "Below one month of expenses",
      explanation:
        "Current cash is less than one month of average spending. Confirm upcoming deposits before committing to new purchases.",
    };
  }
  if (months < 3) {
    return {
      level: "attention",
      label: `About ${months.toFixed(1)} months of expenses`,
      explanation: "Current cash covers under three months of average spending.",
    };
  }
  return {
    level: "positive",
    label: `About ${months.toFixed(1)} months of expenses`,
    explanation: "Current cash comfortably covers recent average spending.",
  };
}
