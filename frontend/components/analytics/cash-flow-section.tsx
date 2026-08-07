"use client";

/**
 * Cash flow.
 *
 * Canonical home for "money in and out by month." The 30/60/90 outlook was
 * removed from the dashboard surface — the chart alone matches the mockup.
 */

import type { AnalyticsResult } from "../../lib/analytics/engine";
import { IncomeExpenseChart } from "./charts";
import { AnalyticsSection } from "./primitives";

export function CashFlowChartCard({
  result,
  sectionId,
}: {
  result: AnalyticsResult;
  sectionId: string;
}) {
  const { cashFlow } = result;

  return (
    <AnalyticsSection id={sectionId} eyebrow="Planning" title="Cash flow trend">
      <IncomeExpenseChart
        title=""
        points={cashFlow.months.map((month) => ({
          monthKey: month.monthKey,
          incomeCents: month.inflowCents,
          expenseCents: month.outflowCents,
          netCents: month.netCents,
        }))}
        emptyMessage="No cash movement recorded in this period."
      />
    </AnalyticsSection>
  );
}
