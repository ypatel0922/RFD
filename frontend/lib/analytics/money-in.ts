/**
 * Where the department's money came from in a period.
 *
 * Only `income` counts: transfers, refunds, card payments and pending bank rows
 * are already separated by classification, so they never appear here.
 */

import type { Cents } from "../reconciliation/money";
import {
  MONEY_IN_SOURCE_BUCKET_LABELS,
  moneyInSourceBucket,
  type MoneyInSourceBucket,
} from "../money-in/categories";
import type { AnalyticsTransaction } from "./types";

export type MoneyInSourceRow = {
  key: MoneyInSourceBucket;
  label: string;
  cents: Cents;
  count: number;
  /** Categories that rolled into this source, largest first — used for drilldown. */
  categories: Array<{ name: string; cents: Cents }>;
};

export function moneyInBySource(transactions: AnalyticsTransaction[]): MoneyInSourceRow[] {
  const buckets = new Map<MoneyInSourceBucket, { cents: number; count: number; categories: Map<string, number> }>();
  for (const transaction of transactions) {
    if (transaction.classification !== "income") continue;
    const key = moneyInSourceBucket(transaction.category, transaction.isTwoPercent);
    const bucket = buckets.get(key) ?? { cents: 0, count: 0, categories: new Map<string, number>() };
    bucket.cents += transaction.magnitudeCents;
    bucket.count += 1;
    const name = transaction.category ?? "";
    if (name) bucket.categories.set(name, (bucket.categories.get(name) ?? 0) + transaction.magnitudeCents);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .map(([key, bucket]) => ({
      key,
      label: MONEY_IN_SOURCE_BUCKET_LABELS[key],
      cents: bucket.cents,
      count: bucket.count,
      categories: [...bucket.categories.entries()]
        .map(([name, cents]) => ({ name, cents }))
        .sort((a, b) => b.cents - a.cents),
    }))
    .sort((a, b) => b.cents - a.cents);
}
