"use client";

/**
 * Department Health.
 *
 * Compact KPI card matching the mockup: status headline with shield, four
 * icon chips for component scores, and a detail drawer for methodology.
 */

import { useState, type ReactNode } from "react";

import { describeChange, formatMoney, formatPercent, STATUS_LABELS } from "../../lib/analytics/format";
import type { AnalyticsResult } from "../../lib/analytics/engine";
import type { DrilldownTarget, StatusLevel } from "../../lib/analytics/types";
import {
  CheckCircleIcon,
  FileTextIcon,
  FolderIcon,
  HeartPulseIcon,
  ShieldCheckIcon,
} from "./icons";
import {
  AnalyticsSection,
  Drawer,
  InfoTip,
  MetricCard,
  ProgressMeter,
  StatusPill,
} from "./primitives";

const SCORE_DISCLAIMER =
  "Hallix Department Health is a recordkeeping indicator calculated from your own data. " +
  "It is not an audit, an audit opinion, or a determination of legal compliance.";

const STRIP_COMPONENTS: Array<{
  id: string;
  label: string;
  tone: "blue" | "green" | "orange" | "teal";
  icon: ReactNode;
}> = [
  { id: "reconciliation", label: "Reconciliation", tone: "blue", icon: <CheckCircleIcon size={15} /> },
  { id: "receipts", label: "Documentation", tone: "green", icon: <FileTextIcon size={15} /> },
  { id: "categorization", label: "Categorization", tone: "orange", icon: <FolderIcon size={15} /> },
  { id: "cash", label: "Financial position", tone: "teal", icon: <HeartPulseIcon size={15} /> },
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

  const strip = STRIP_COMPONENTS.map((entry) => {
    const component = health.components.find((c) => c.id === entry.id);
    return component ? { ...entry, component } : null;
  }).filter((entry): entry is NonNullable<typeof entry> => entry != null);

  const statusLabel =
    health.hasSufficientData && health.status
      ? health.status
      : health.hasSufficientData
        ? STATUS_LABELS[health.level]
        : "Insufficient data";

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
      <div className="fb-an-health-hero">
        <button
          type="button"
          className="fb-an-health-status"
          onClick={() => setShowDetail(true)}
          aria-label="Open the full health calculation"
        >
          <span className={`fb-an-health-shield ${statusTone(health.level)}`} aria-hidden="true">
            <ShieldCheckIcon size={22} />
          </span>
          <span className="fb-an-health-status-copy">
            <span className="fb-an-health-status-label">{statusLabel}</span>
            <span className="fb-an-health-status-sub">
              {health.insufficientDataReason ?? health.headline}
            </span>
          </span>
        </button>

        <div className="fb-an-icon-stat-row">
          {strip.map(({ id, label, tone, icon, component }) => (
            <button
              key={id}
              type="button"
              className="fb-an-icon-stat"
              onClick={() => setShowDetail(true)}
            >
              <span className={`fb-an-icon-chip fb-an-icon-chip--${tone}`} aria-hidden="true">
                {icon}
              </span>
              <span className="fb-an-icon-stat-label">{label}</span>
              <span className="fb-an-icon-stat-value">
                {component.score == null
                  ? STATUS_LABELS.unknown
                  : id === "reconciliation" || id === "categorization" || id === "receipts"
                    ? formatPercent(component.score, 0)
                    : STATUS_LABELS[component.level]}
              </span>
            </button>
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

function statusTone(level: StatusLevel): string {
  if (level === "positive") return "fb-an-health-shield--positive";
  if (level === "attention") return "fb-an-health-shield--attention";
  if (level === "risk") return "fb-an-health-shield--risk";
  return "fb-an-health-shield--unknown";
}
