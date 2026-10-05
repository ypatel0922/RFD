"use client";

/**
 * Mobile-only Analytics snapshot: the Total Spending hero and the four compact
 * KPI tiles. Hidden on tablet and desktop by CSS (`fb-an-mobile-only`), so the
 * desktop layout is untouched. Every figure comes from the existing
 * AnalyticsResult — nothing is derived or invented here.
 */

import type { ReactNode } from "react";

import { formatRangeLabel } from "../../lib/analytics/date-range";
import type { AnalyticsResult } from "../../lib/analytics/engine";
import {
  formatMoney,
  formatMoneyCompact,
  formatMoneyRounded,
  formatPercent,
  STATUS_LABELS,
} from "../../lib/analytics/format";
import { analyticsSectionAnchor } from "../../lib/navigation";
import { ChevronRightIcon, FileTextIcon, FolderIcon, ShieldCheckIcon, WalletIcon } from "./icons";

export function MobileSnapshot({
  result,
  onScrollTo,
}: {
  result: AnalyticsResult;
  onScrollTo: (anchor: string) => void;
}) {
  const { totals, expenseChange, cash, health, documentation: docs, period, cashFlow } = result;

  const categorization = health.components.find((component) => component.id === "categorization");
  const cashComponent = health.components.find((component) => component.id === "cash");
  const financialLevel = cashComponent?.level ?? health.level;
  const financialLabel =
    cashComponent?.score == null && !health.hasSufficientData
      ? STATUS_LABELS.unknown
      : STATUS_LABELS[financialLevel];

  const trendPercent =
    expenseChange.hasComparison && expenseChange.percent != null && expenseChange.deltaCents !== 0
      ? expenseChange.percent
      : null;

  // Short enough to sit on one line next to the percentage.
  const comparisonSuffix =
    period.comparisonMode === "same_period_last_year" ? "vs. last year" : "vs. prior period";

  const series = cashFlow.months.map((month) => month.outflowCents);
  const showSpark = series.length >= 2 && series.some((value) => value > 0);

  return (
    <div className="fb-an-snapshot fb-an-mobile-only">
      <button
        type="button"
        className="card fb-an-hero"
        onClick={() => onScrollTo(analyticsSectionAnchor("spending"))}
        aria-label={`Total spending ${formatMoney(totals.expenseCents)}. Open spending breakdown.`}
      >
        <span className="fb-an-hero-head">
          <span className="fb-an-hero-heading">
            <span className="fb-an-hero-label">Total Spending</span>
            <span className="fb-an-hero-sub">{period.label}</span>
          </span>
          <span className="fb-an-hero-range">{formatRangeLabel(period.range)}</span>
        </span>
        <span className="fb-an-hero-value">{formatMoney(totals.expenseCents)}</span>
        {trendPercent != null ? (
          <span
            className={`fb-an-hero-trend ${trendPercent > 0 ? "fb-an-hero-trend--up" : "fb-an-hero-trend--down"}`}
          >
            <span className="fb-an-hero-trend-pill">
              <span aria-hidden="true">{trendPercent > 0 ? "▲" : "▼"}</span>
              {formatPercent(Math.abs(trendPercent), 0)}
            </span>
            <span className="fb-an-hero-trend-note">{comparisonSuffix}</span>
          </span>
        ) : (
          <span className="fb-an-hero-trend fb-an-hero-trend--flat">
            <span className="fb-an-hero-trend-note">{flatTrendNote(expenseChange)}</span>
          </span>
        )}
        {showSpark ? <Sparkline values={series} /> : null}
      </button>

      <div className="fb-an-kpi-tiles" role="list" aria-label="Key metrics">
        <KpiTile
          label="Cash"
          fullLabel="Cash position"
          value={
            cash.hasIncompleteBalances && cash.totalCashCents === 0
              ? "—"
              : Math.abs(cash.totalCashCents) >= 10_000_000
                ? formatMoneyCompact(cash.totalCashCents)
                : formatMoneyRounded(cash.totalCashCents)
          }
          hint="On hand"
          tone="red"
          icon={<WalletIcon size={15} />}
          onClick={() => onScrollTo(analyticsSectionAnchor("accounts"))}
        />
        <KpiTile
          label="Receipts"
          fullLabel="Receipts on file"
          value={formatPercent(docs.receiptCompletionPercent, 0)}
          hint={docs.missingReceiptCount > 0 ? `${docs.missingReceiptCount} missing` : "All on file"}
          tone="blue"
          icon={<FileTextIcon size={15} />}
          onClick={() => onScrollTo(analyticsSectionAnchor("readiness"))}
        />
        <KpiTile
          label="Categorized"
          fullLabel="Categorization"
          value={formatPercent(categorization?.score, 0)}
          hint={docs.uncategorizedCount > 0 ? `${docs.uncategorizedCount} missing` : "All done"}
          tone="orange"
          icon={<FolderIcon size={15} />}
          onClick={() => onScrollTo(analyticsSectionAnchor("readiness"))}
        />
        <KpiTile
          label="Health"
          fullLabel="Financial health"
          value={financialLabel}
          tone="green"
          icon={<ShieldCheckIcon size={15} />}
          onClick={() => onScrollTo(analyticsSectionAnchor("overview"))}
        />
      </div>
    </div>
  );
}

/**
 * A percentage needs a non-zero baseline, so say which of the three reasons
 * applies instead of implying the spending was flat.
 */
function flatTrendNote(change: AnalyticsResult["expenseChange"]): string {
  if (!change.hasComparison) return "No comparison selected";
  if (change.deltaCents === 0) return "No change vs. comparison";
  return "No spending in the comparison period";
}

function KpiTile({
  label,
  fullLabel,
  value,
  hint,
  tone,
  icon,
  onClick,
}: {
  label: string;
  fullLabel: string;
  value: string;
  hint?: string;
  tone: "red" | "blue" | "orange" | "green";
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`fb-an-kpi-tile fb-an-kpi-tile--${tone}`}
      role="listitem"
      onClick={onClick}
      aria-label={`${fullLabel}: ${value}${hint ? `, ${hint}` : ""}. View details.`}
    >
      <span className={`fb-an-kpi-tile-icon fb-an-kpi-tile-icon--${tone}`} aria-hidden="true">
        {icon}
      </span>
      <span className="fb-an-kpi-tile-label">{label}</span>
      <span className="fb-an-kpi-tile-value">{value}</span>
      {hint ? <span className="fb-an-kpi-tile-hint">{hint}</span> : null}
      <span className="fb-an-kpi-tile-chevron" aria-hidden="true">
        <ChevronRightIcon size={14} />
      </span>
    </button>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const width = 300;
  const height = 72;
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const points = values.map((value, index) => ({
    x: index * step,
    y: height - 8 - (value / max) * (height - 20),
  }));
  const line = smoothPath(points);
  const area = `${line} L${width},${height} L0,${height} Z`;
  const last = points[points.length - 1];

  return (
    <svg
      className="fb-an-hero-spark"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="fb-an-hero-spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#b42318" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#b42318" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#fb-an-hero-spark-fill)" />
      <path
        d={line}
        fill="none"
        stroke="#b42318"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={last.x} cy={last.y} r="3" fill="#b42318" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Catmull-Rom through the points, so the line reads as a curve rather than a zigzag. */
function smoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length < 3) {
    return points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`).join(" ");
  }

  let path = `M${points[0].x},${points[0].y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index - 1] ?? points[index];
    const current = points[index];
    const next = points[index + 1];
    const after = points[index + 2] ?? next;
    const c1x = current.x + (next.x - previous.x) / 6;
    const c1y = current.y + (next.y - previous.y) / 6;
    const c2x = next.x - (after.x - current.x) / 6;
    const c2y = next.y - (after.y - current.y) / 6;
    path += ` C${c1x},${c1y} ${c2x},${c2y} ${next.x},${next.y}`;
  }
  return path;
}
