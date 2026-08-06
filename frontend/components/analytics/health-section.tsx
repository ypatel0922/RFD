"use client";

/**
 * Department Health.
 *
 * The score is a Hallix planning indicator, never an audit opinion, and the
 * wording throughout is chosen to keep that distinction obvious. When there is
 * too little activity to judge fairly, the section says so instead of printing
 * a number.
 *
 * The dashboard shows one compact strip — score, status, the single biggest
 * issue, and four at-a-glance component dots. Every calculation, the full
 * component list, and the methodology live in a detail drawer opened from
 * here, so nothing is duplicated elsewhere on the page.
 */

import { useState } from "react";

import { describeChange, formatMoney, formatPercent, STATUS_LABELS } from "../../lib/analytics/format";
import type { AnalyticsResult } from "../../lib/analytics/engine";
import type { DrilldownTarget } from "../../lib/analytics/types";
import {
  AnalyticsSection,
  Drawer,
  InfoTip,
  MetricCard,
  MiniStat,
  ProgressMeter,
  StatusPill,
} from "./primitives";

const SCORE_DISCLAIMER =
  "Hallix Department Health is a recordkeeping indicator calculated from your own data. " +
  "It is not an audit, an audit opinion, or a determination of legal compliance.";

/** The four components shown in the compact strip, in this fixed order. */
const STRIP_COMPONENTS: Array<{ id: string; label: string }> = [
  { id: "reconciliation", label: "Reconciliation" },
  { id: "receipts", label: "Documentation" },
  { id: "categorization", label: "Categorization" },
  { id: "cash", label: "Financial position" },
];

export function HealthSection({
  result,
  sectionId,
  onDrilldown,
}: {
  result: AnalyticsResult;
  sectionId: string;
  onDrilldown: (target: DrilldownTarget) => void;
}) {
  const [showDetail, setShowDetail] = useState(false);
  const { health } = result;

  const strip = STRIP_COMPONENTS.map((entry) => health.components.find((c) => c.id === entry.id))
    .filter((component): component is (typeof health.components)[number] => component != null);

  return (
    <AnalyticsSection
      id={sectionId}
      eyebrow="Department health"
      title="Financial position"
      actions={
        <button type="button" className="fb-an-view-link" onClick={() => setShowDetail(true)}>
          View details
        </button>
      }
    >
      <div className="fb-an-health-strip">
        <div className="fb-an-health-strip-score">
          <button type="button" onClick={() => setShowDetail(true)} aria-label="Open the full health calculation">
            {health.hasSufficientData && health.score != null ? (
              <>
                <span className="fb-an-health-strip-value">{health.score}</span>
                <StatusPill level={health.level} label={health.status ?? undefined} />
              </>
            ) : (
              <StatusPill level="unknown" label="Insufficient data" />
            )}
          </button>
        </div>

        <div className="fb-an-health-strip-copy">
          <p className="fb-an-health-strip-headline">
            {health.insufficientDataReason ?? health.headline}
          </p>
        </div>

        <div className="fb-an-mini-row">
          {strip.map((component) => (
            <MiniStat
              key={component.id}
              label={STRIP_COMPONENTS.find((entry) => entry.id === component.id)?.label ?? component.label}
              value={
                component.score == null
                  ? STATUS_LABELS.unknown
                  : component.id === "reconciliation" || component.id === "categorization" || component.id === "receipts"
                    ? formatPercent(component.score, 0)
                    : STATUS_LABELS[component.level]
              }
              level={component.level}
              onClick={() => setShowDetail(true)}
            />
          ))}
        </div>
      </div>

      {showDetail ? (
        <Drawer title="Hallix Department Health" eyebrow="Overview" onClose={() => setShowDetail(false)}>
          <p className="fb-an-disclaimer">
            {SCORE_DISCLAIMER}
            <InfoTip text={health.methodology} label="How Department Health is calculated" />
          </p>

          <h4 className="fb-an-subheading">What makes up this status</h4>
          <ul className="fb-an-component-list">
            {health.components.map((component) => (
              <li key={component.id} className="fb-an-component">
                <div className="fb-an-component-head">
                  <span className="fb-an-component-label">
                    {component.label}
                    <InfoTip text={component.method} label={`How ${component.label} is measured`} />
                  </span>
                  <StatusPill level={component.level} size="small" />
                </div>
                <ProgressMeter
                  percent={component.score}
                  level={component.level}
                  label={`${component.label}: ${component.score == null ? "not measured" : formatPercent(component.score, 0)}`}
                />
                <p className="fb-an-component-detail">{component.detail}</p>
                {component.drilldown ? (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => onDrilldown(component.drilldown as DrilldownTarget)}
                  >
                    {component.actionLabel ?? "View records"}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>

          <h4 className="fb-an-subheading">Where the department stands</h4>
          <div className="fb-metric-grid">
            <MetricCard
              label="Money available"
              value={
                result.cash.hasIncompleteBalances && result.cash.totalCashCents === 0
                  ? "—"
                  : formatMoney(result.cash.totalCashCents)
              }
              hint={
                result.cash.hasIncompleteBalances
                  ? "Some accounts have no recorded starting balance yet"
                  : "Cash and savings across all accounts"
              }
              info="Total of checking, savings and cash accounts. Credit card balances are not included here."
              onClick={() => onDrilldown({ kind: "accounts" })}
              actionLabel="Money available. Open accounts."
            />
            <MetricCard
              label="2% fund balance"
              value={
                result.twoPercent?.currentBalanceCents != null
                  ? formatMoney(result.twoPercent.currentBalanceCents)
                  : "—"
              }
              hint={
                result.twoPercent == null
                  ? "No 2% account identified yet"
                  : result.twoPercent.currentBalanceCents == null
                    ? "No starting balance recorded for the 2% account"
                    : `Carried in plus received, less spent, for ${result.twoPercent.reportYear}`
              }
              onClick={() =>
                onDrilldown(
                  result.twoPercent == null
                    ? { kind: "settings_accounts" }
                    : { kind: "transactions", filters: { quickFilter: "two_percent" } },
                )
              }
            />
            <MetricCard
              label="Credit card owed"
              value={formatMoney(result.cash.creditCardBalanceCents)}
              tone={result.cash.creditCardBalanceCents > 0 ? "out" : undefined}
              hint="Outstanding balance on department cards"
              info="Card balances are shown separately from cash and subtracted when calculating what is genuinely available."
              onClick={() => onDrilldown({ kind: "accounts" })}
            />
            <MetricCard
              label="Available after cards"
              value={formatMoney(result.cash.netLiquidCents)}
              hint="Cash less what is owed on cards"
            />
            <MetricCard
              label="Money in"
              value={formatMoney(result.totals.incomeCents)}
              change={describeChange(result.incomeChange)}
              hint="Excludes transfers between your own accounts"
              onClick={() => onDrilldown({ kind: "transactions", filters: { quickFilter: "income" } })}
            />
            <MetricCard
              label="Money out"
              value={formatMoney(result.totals.expenseCents)}
              tone="out"
              change={describeChange(result.expenseChange)}
              hint="Spending after refunds, excluding card payments and transfers"
              onClick={() => onDrilldown({ kind: "transactions", filters: { quickFilter: "expenses" } })}
            />
            <MetricCard
              label="Not yet reconciled"
              value={result.documentation.unreconciledCount}
              tone={result.documentation.staleUnreconciledCount > 0 ? "warn" : undefined}
              hint={
                result.documentation.staleUnreconciledCount > 0
                  ? `${result.documentation.staleUnreconciledCount} open more than 30 days`
                  : "Transactions still to be matched to a statement"
              }
              onClick={() => onDrilldown({ kind: "reconciliation", queue: "unreconciled" })}
            />
            <MetricCard
              label="Missing receipts"
              value={result.documentation.missingReceiptCount}
              tone={result.documentation.missingReceiptCount > 0 ? "warn" : undefined}
              hint={
                result.documentation.receiptCompletionPercent == null
                  ? "No expenses recorded in this period"
                  : `${formatPercent(result.documentation.receiptCompletionPercent, 0)} of expenses have one`
              }
              onClick={() => onDrilldown({ kind: "reconciliation", queue: "missing_receipt" })}
            />
          </div>

          <p className="muted fb-an-footnote">
            {STATUS_LABELS.unknown} appears wherever the department has not recorded enough for Hallix
            to judge a component fairly. A short history never counts against the score.
          </p>
        </Drawer>
      ) : null}
    </AnalyticsSection>
  );
}
