"use client";

/**
 * Cash flow.
 *
 * Canonical home for "money in and out by month." The 30/60/90 outlook was
 * removed from the dashboard surface — the chart alone matches the mockup.
 */

import type { AnalyticsResult } from "../../lib/analytics/engine";
import { formatMoney } from "../../lib/analytics/format";
import type { DrilldownTarget } from "../../lib/analytics/types";
import { IncomeExpenseChart } from "./charts";
import { AnalyticsSection } from "./primitives";

export function CashFlowChartCard({
  result,
  sectionId,
  onDrilldown,
}: {
  result: AnalyticsResult;
  sectionId: string;
  onDrilldown?: (target: DrilldownTarget) => void;
}) {
  const { cashFlow, moneyInBySource } = result;
  const moneyInTotal = moneyInBySource.reduce((sum, row) => sum + row.cents, 0);

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
      {moneyInBySource.length > 0 ? (
        <details className="fb-an-money-in-sources">
          <summary>
            Money in by source · {formatMoney(moneyInTotal)}
          </summary>
          <p className="muted">Transfers between your accounts and refunds are not counted as money in.</p>
          <ul>
            {moneyInBySource.map((row) => {
              const category = row.categories[0]?.name;
              const canDrill = Boolean(onDrilldown && category && row.categories.length === 1);
              return (
                <li key={row.key}>
                  {canDrill ? (
                    <button
                      type="button"
                      className="fb-an-money-in-source-row"
                      onClick={() =>
                        onDrilldown?.({
                          kind: "transactions",
                          filters: {
                            category,
                            quickFilter: "income",
                            dateFrom: result.period.range.start,
                            dateTo: result.period.range.end,
                          },
                        })
                      }
                    >
                      <span>{row.label}</span>
                      <span>{formatMoney(row.cents)}</span>
                    </button>
                  ) : (
                    <div className="fb-an-money-in-source-row">
                      <span>{row.label}</span>
                      <span>{formatMoney(row.cents)}</span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </AnalyticsSection>
  );
}
