"use client";

/**
 * Cash flow.
 *
 * This is the single, canonical home for "money in and out by month" — it
 * used to be drawn twice (once under Spending, once under Budget) and now
 * lives here only. The outlook is a straight-line estimate from recent
 * months and says so plainly; where there is not enough history it shows an
 * honest empty state rather than a made-up number.
 *
 * Rendered as two adjacent cards — the chart, and the 30/60/90 day outlook —
 * so they can sit side by side in the dashboard grid the way a chief scans a
 * cash-flow chart next to its projection.
 */

import { formatMoney, formatSignedMoney } from "../../lib/analytics/format";
import type { AnalyticsResult } from "../../lib/analytics/engine";
import { IncomeExpenseChart } from "./charts";
import { AnalyticsSection, EmptyState, InfoTip, StatusPill } from "./primitives";

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
        title="Money in and out by month"
        description="Transfers between the department's own accounts are excluded from both series."
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

export function CashFlowOutlookCard({ result }: { result: AnalyticsResult }) {
  const { cashFlow } = result;

  return (
    <AnalyticsSection
      id="fb-an-cash-outlook"
      eyebrow="Planning"
      title="30/60/90 day outlook"
      actions={
        <InfoTip
          label="How the outlook is estimated"
          text="Hallix continues the department's recent average monthly net change forward from the current balance. It is a straight-line estimate, not a prediction, and it does not know about planned purchases or grants."
        />
      }
    >
      {!cashFlow.outlook.available ? (
        <EmptyState
          title="Not enough information to project cash"
          message={
            cashFlow.outlook.unavailableReason ??
            "Hallix needs more recorded history before it can estimate where cash is heading."
          }
        />
      ) : (
        <>
          <div className="fb-an-compact-metric">
            <p className="fb-an-compact-metric-label">Average monthly change</p>
            <p
              className={`fb-an-compact-metric-value ${cashFlow.outlook.averageMonthlyNetCents < 0 ? "fb-an-compact-metric-value--out" : ""}`}
            >
              {formatSignedMoney(cashFlow.outlook.averageMonthlyNetCents)}
            </p>
          </div>

          <ul className="fb-an-top-list">
            {cashFlow.outlook.projections.map((projection) => (
              <li key={projection.horizonDays} className="fb-an-top-row">
                <span className="fb-an-top-row-name">Estimated in {projection.horizonDays} days</span>
                <span className="fb-an-top-row-meta">
                  <span className="fb-an-top-row-amount">
                    {projection.projectedBalanceCents == null
                      ? "—"
                      : formatMoney(projection.projectedBalanceCents)}
                  </span>
                </span>
              </li>
            ))}
          </ul>

          {cashFlow.outlook.runwayStatus ? (
            <p className="fb-an-pace">
              <StatusPill
                level={cashFlow.outlook.runwayStatus.level}
                label={cashFlow.outlook.runwayStatus.label}
                size="small"
              />
              <span>{cashFlow.outlook.runwayStatus.explanation}</span>
            </p>
          ) : null}
        </>
      )}
    </AnalyticsSection>
  );
}
