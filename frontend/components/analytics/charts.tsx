"use client";

/**
 * Chart wrappers for the Analytics tab.
 *
 * Every chart here is paired with a real table carrying the same numbers. The
 * chart is the fast read; the table is what a screen reader announces, what a
 * treasurer copies into a board packet, and what stays legible on a phone.
 *
 * Colours come from the existing Hallix tokens. There is no analytics-specific
 * palette, and colour never carries meaning on its own — every series is also
 * named in the legend and the table.
 */

import { useId, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  formatMoney,
  formatMoneyCompact,
  formatMonthLabel,
  formatPercent,
} from "../../lib/analytics/format";
import type { Cents } from "../../lib/reconciliation/money";

/**
 * A restrained categorical ramp built from the Hallix deep red and navy. It
 * stays readable side by side and never introduces a colour the rest of the app
 * does not already use.
 */
export const CATEGORY_COLORS = [
  "#7f1d1d",
  "#0f172a",
  "#b54708",
  "#1c2536",
  "#8b2424",
  "#344054",
  "#651717",
  "#5c6578",
  "#a3542c",
  "#101828",
] as const;

export const SERIES_COLORS = {
  income: "#067647",
  expense: "#7f1d1d",
  net: "#0f172a",
  neutral: "#5c6578",
} as const;

const AXIS_STYLE = { fill: "#5c6578", fontSize: 12 } as const;
const GRID_COLOR = "#e1e6ef";

const TOOLTIP_STYLE = {
  background: "#ffffff",
  border: "1px solid #e1e6ef",
  borderRadius: 10,
  boxShadow: "0 12px 32px rgb(15 23 42 / 12%)",
  fontSize: 13,
  color: "#101828",
} as const;

/**
 * Recharts hands axis and tooltip callbacks loosely typed values. These
 * adapters coerce once, here, so each chart below can be written in terms of
 * cents and month keys instead of repeating the same guards.
 */
function moneyTick(value: unknown): string {
  return formatMoneyCompact(toCents(value));
}

function moneyTooltip(value: unknown, name: unknown): [string, string] {
  return [formatMoney(toCents(value)), String(name ?? "")];
}

function monthTick(value: unknown): string {
  return formatMonthLabel(String(value ?? ""));
}

function toCents(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

// ─── Frame ───────────────────────────────────────────────────────────────────

export type ChartTableColumn<Row> = {
  header: string;
  cell: (row: Row) => ReactNode;
  numeric?: boolean;
};

/**
 * Wraps a chart with its heading, its screen-reader summary, and the table
 * fallback. Charts should never be rendered bare.
 */
export function ChartFrame<Row>({
  title,
  description,
  summary,
  isEmpty,
  emptyMessage,
  height = 260,
  rows,
  columns,
  rowKey,
  tableLabel,
  children,
}: {
  title: string;
  description?: string;
  /** One sentence a screen reader hears in place of the drawing. */
  summary: string;
  isEmpty: boolean;
  emptyMessage: string;
  height?: number;
  rows: Row[];
  columns: ChartTableColumn<Row>[];
  rowKey: (row: Row, index: number) => string;
  tableLabel?: string;
  children: ReactNode;
}) {
  const headingId = useId();

  return (
    <figure className="fb-an-chart" aria-labelledby={headingId}>
      <figcaption className="fb-an-chart-head">
        <h4 id={headingId} className="fb-an-chart-title">
          {title}
        </h4>
        {description ? <p className="fb-an-chart-desc">{description}</p> : null}
      </figcaption>

      {isEmpty ? (
        <p className="empty-state fb-an-chart-empty">{emptyMessage}</p>
      ) : (
        <>
          <div className="fb-an-chart-canvas" style={{ height }} role="img" aria-label={summary}>
            <ResponsiveContainer width="100%" height="100%">
              {children as React.ReactElement}
            </ResponsiveContainer>
          </div>

          <details className="fb-an-chart-data">
            <summary>View as table</summary>
            <div className="table-wrap">
              <table>
                <caption className="fb-an-visually-hidden">{tableLabel ?? title}</caption>
                <thead>
                  <tr>
                    {columns.map((column) => (
                      <th key={column.header} scope="col">
                        {column.header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={rowKey(row, index)}>
                      {columns.map((column, columnIndex) => (
                        <td key={column.header}>
                          {columnIndex === 0 ? <span>{column.cell(row)}</span> : column.cell(row)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </figure>
  );
}

// ─── Category donut ──────────────────────────────────────────────────────────

export type DonutSlice = {
  label: string;
  amountCents: Cents;
  percent: number;
  count?: number;
};

export function CategoryDonut({
  title,
  description,
  slices,
  emptyMessage,
  centerLabel,
  centerValue,
  height = 168,
  onSelect,
}: {
  title: string;
  description?: string;
  slices: DonutSlice[];
  emptyMessage: string;
  centerLabel?: string;
  centerValue?: string;
  height?: number;
  onSelect?: (label: string) => void;
}) {
  const total = slices.reduce((sum, slice) => sum + slice.amountCents, 0);
  const leaders = slices
    .slice(0, 3)
    .map((slice) => `${slice.label} ${formatPercent(slice.percent)}`)
    .join(", ");

  return (
    <ChartFrame
      title={title}
      description={description}
      summary={`${title}. ${formatMoney(total)} across ${slices.length} categories. Largest: ${leaders}.`}
      isEmpty={slices.length === 0}
      emptyMessage={emptyMessage}
      height={height}
      rows={slices}
      rowKey={(slice) => slice.label}
      columns={[
        { header: "Category", cell: (slice) => slice.label },
        { header: "Amount", cell: (slice) => formatMoney(slice.amountCents), numeric: true },
        { header: "Share", cell: (slice) => formatPercent(slice.percent), numeric: true },
        ...(slices.some((slice) => slice.count != null)
          ? [
              {
                header: "Transactions",
                cell: (slice: DonutSlice) => slice.count ?? "—",
                numeric: true,
              },
            ]
          : []),
      ]}
    >
      <PieChart>
        <Pie
          data={slices}
          dataKey="amountCents"
          nameKey="label"
          innerRadius="58%"
          outerRadius="82%"
          paddingAngle={1}
          stroke="#ffffff"
          strokeWidth={2}
          isAnimationActive={false}
          onClick={
            onSelect
              ? (entry: unknown) => {
                  const label = (entry as { label?: unknown } | null)?.label;
                  if (typeof label === "string") onSelect(label);
                }
              : undefined
          }
          cursor={onSelect ? "pointer" : undefined}
        >
          {slices.map((slice, index) => (
            <Cell key={slice.label} fill={CATEGORY_COLORS[index % CATEGORY_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          formatter={moneyTooltip}
        />
        {centerValue ? (
          <text
            x="50%"
            y="50%"
            textAnchor="middle"
            dominantBaseline="middle"
            className="fb-an-donut-center"
          >
            <tspan x="50%" dy="-0.4em" className="fb-an-donut-center-value">
              {centerValue}
            </tspan>
            {centerLabel ? (
              <tspan x="50%" dy="1.6em" className="fb-an-donut-center-label">
                {centerLabel}
              </tspan>
            ) : null}
          </text>
        ) : null}
      </PieChart>
    </ChartFrame>
  );
}

// ─── Income vs expenses ──────────────────────────────────────────────────────

export type TrendPoint = {
  monthKey: string;
  incomeCents: Cents;
  expenseCents: Cents;
  netCents: Cents;
};

export function IncomeExpenseChart({
  title,
  description,
  points,
  emptyMessage,
}: {
  title: string;
  description?: string;
  points: TrendPoint[];
  emptyMessage: string;
}) {
  const totalIncome = points.reduce((sum, point) => sum + point.incomeCents, 0);
  const totalExpense = points.reduce((sum, point) => sum + point.expenseCents, 0);

  return (
    <ChartFrame
      title={title}
      description={description}
      summary={`${title}. ${formatMoney(totalIncome)} in and ${formatMoney(totalExpense)} out across ${points.length} months.`}
      isEmpty={points.length === 0}
      emptyMessage={emptyMessage}
      height={180}
      rows={points}
      rowKey={(point) => point.monthKey}
      columns={[
        { header: "Month", cell: (point) => formatMonthLabel(point.monthKey) },
        { header: "Money in", cell: (point) => formatMoney(point.incomeCents), numeric: true },
        { header: "Money out", cell: (point) => formatMoney(point.expenseCents), numeric: true },
        { header: "Net", cell: (point) => formatMoney(point.netCents), numeric: true },
      ]}
    >
      <BarChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid stroke={GRID_COLOR} vertical={false} />
        <XAxis
          dataKey="monthKey"
          tickFormatter={monthTick}
          tick={AXIS_STYLE}
          tickLine={false}
          axisLine={{ stroke: GRID_COLOR }}
        />
        <YAxis
          tickFormatter={moneyTick}
          tick={AXIS_STYLE}
          tickLine={false}
          axisLine={false}
          width={64}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelFormatter={monthTick}
          formatter={moneyTooltip}
        />
        <Legend iconType="circle" wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
        <Bar dataKey="incomeCents" name="Money in" fill={SERIES_COLORS.income} radius={[3, 3, 0, 0]} isAnimationActive={false} />
        <Bar dataKey="expenseCents" name="Money out" fill={SERIES_COLORS.expense} radius={[3, 3, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ChartFrame>
  );
}

// ─── Single-series trend ─────────────────────────────────────────────────────

export function SpendTrendChart({
  title,
  description,
  points,
  emptyMessage,
  seriesName = "Spending",
}: {
  title: string;
  description?: string;
  points: { monthKey: string; amountCents: Cents }[];
  emptyMessage: string;
  seriesName?: string;
}) {
  const total = points.reduce((sum, point) => sum + point.amountCents, 0);

  return (
    <ChartFrame
      title={title}
      description={description}
      summary={`${title}. ${formatMoney(total)} total across ${points.length} months.`}
      isEmpty={points.length === 0}
      emptyMessage={emptyMessage}
      height={220}
      rows={points}
      rowKey={(point) => point.monthKey}
      columns={[
        { header: "Month", cell: (point) => formatMonthLabel(point.monthKey) },
        { header: seriesName, cell: (point) => formatMoney(point.amountCents), numeric: true },
      ]}
    >
      <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid stroke={GRID_COLOR} vertical={false} />
        <XAxis
          dataKey="monthKey"
          tickFormatter={monthTick}
          tick={AXIS_STYLE}
          tickLine={false}
          axisLine={{ stroke: GRID_COLOR }}
        />
        <YAxis
          tickFormatter={moneyTick}
          tick={AXIS_STYLE}
          tickLine={false}
          axisLine={false}
          width={64}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelFormatter={monthTick}
          formatter={(value: unknown) => moneyTooltip(value, seriesName)}
        />
        <Line
          type="monotone"
          dataKey="amountCents"
          name={seriesName}
          stroke={SERIES_COLORS.expense}
          strokeWidth={2}
          dot={{ r: 2.5 }}
          activeDot={{ r: 4 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartFrame>
  );
}

// ─── Balance trend ───────────────────────────────────────────────────────────

export function BalanceTrendChart({
  title,
  description,
  points,
  emptyMessage,
  height = 96,
}: {
  title: string;
  description?: string;
  points: { monthKey: string; balanceCents: Cents }[];
  emptyMessage: string;
  height?: number;
}) {
  const last = points.at(-1);

  return (
    <ChartFrame
      title={title}
      description={description}
      summary={`${title}. Ending balance ${last ? formatMoney(last.balanceCents) : "unavailable"} across ${points.length} months.`}
      isEmpty={points.length === 0}
      emptyMessage={emptyMessage}
      height={height}
      rows={points}
      rowKey={(point) => point.monthKey}
      columns={[
        { header: "Month", cell: (point) => formatMonthLabel(point.monthKey) },
        { header: "Ending balance", cell: (point) => formatMoney(point.balanceCents), numeric: true },
      ]}
    >
      <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <defs>
          <linearGradient id="fb-an-balance-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={SERIES_COLORS.net} stopOpacity={0.18} />
            <stop offset="100%" stopColor={SERIES_COLORS.net} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID_COLOR} vertical={false} />
        <XAxis
          dataKey="monthKey"
          tickFormatter={monthTick}
          tick={AXIS_STYLE}
          tickLine={false}
          axisLine={{ stroke: GRID_COLOR }}
        />
        <YAxis
          tickFormatter={moneyTick}
          tick={AXIS_STYLE}
          tickLine={false}
          axisLine={false}
          width={64}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelFormatter={monthTick}
          formatter={(value: unknown) => moneyTooltip(value, "Ending balance")}
        />
        <Area
          type="monotone"
          dataKey="balanceCents"
          name="Ending balance"
          stroke={SERIES_COLORS.net}
          strokeWidth={2}
          fill="url(#fb-an-balance-fill)"
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartFrame>
  );
}

// ─── Horizontal comparison bars ──────────────────────────────────────────────

export function ComparisonBars({
  title,
  description,
  rows,
  emptyMessage,
  currentLabel,
  priorLabel,
}: {
  title: string;
  description?: string;
  rows: { label: string; currentCents: Cents; priorCents: Cents }[];
  emptyMessage: string;
  currentLabel: string;
  priorLabel: string;
}) {
  return (
    <ChartFrame
      title={title}
      description={description}
      summary={`${title}. Comparing ${currentLabel} against ${priorLabel} across ${rows.length} categories.`}
      isEmpty={rows.length === 0}
      emptyMessage={emptyMessage}
      height={Math.max(200, rows.length * 44)}
      rows={rows}
      rowKey={(row) => row.label}
      columns={[
        { header: "Category", cell: (row) => row.label },
        { header: currentLabel, cell: (row) => formatMoney(row.currentCents), numeric: true },
        { header: priorLabel, cell: (row) => formatMoney(row.priorCents), numeric: true },
        {
          header: "Change",
          cell: (row) => formatMoney(row.currentCents - row.priorCents),
          numeric: true,
        },
      ]}
    >
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
        <CartesianGrid stroke={GRID_COLOR} horizontal={false} />
        <XAxis
          type="number"
          tickFormatter={moneyTick}
          tick={AXIS_STYLE}
          tickLine={false}
          axisLine={{ stroke: GRID_COLOR }}
        />
        <YAxis
          type="category"
          dataKey="label"
          tick={AXIS_STYLE}
          tickLine={false}
          axisLine={false}
          width={128}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          formatter={moneyTooltip}
        />
        <Legend iconType="circle" wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
        <Bar dataKey="priorCents" name={priorLabel} fill={SERIES_COLORS.neutral} radius={[0, 3, 3, 0]} isAnimationActive={false} />
        <Bar dataKey="currentCents" name={currentLabel} fill={SERIES_COLORS.expense} radius={[0, 3, 3, 0]} isAnimationActive={false} />
      </BarChart>
    </ChartFrame>
  );
}

// ─── Single-series horizontal bars ───────────────────────────────────────────

/** A compact "top N by spend" bar, used where a full comparison isn't needed. */
export function RankedBarChart({
  title,
  description,
  rows,
  emptyMessage,
  seriesName = "Total spend",
  height,
  onSelect,
}: {
  title: string;
  description?: string;
  rows: { label: string; amountCents: Cents }[];
  emptyMessage: string;
  seriesName?: string;
  /** Defaults to a height that fills a dashboard half-card alongside cash flow. */
  height?: number;
  onSelect?: (label: string) => void;
}) {
  const chartHeight = height ?? Math.max(180, rows.length * 44);

  return (
    <ChartFrame
      title={title}
      description={description}
      summary={`${title}. ${rows.map((row) => `${row.label} ${formatMoney(row.amountCents)}`).join(", ")}.`}
      isEmpty={rows.length === 0}
      emptyMessage={emptyMessage}
      height={chartHeight}
      rows={rows}
      rowKey={(row) => row.label}
      columns={[
        { header: "Vendor", cell: (row) => row.label },
        { header: seriesName, cell: (row) => formatMoney(row.amountCents), numeric: true },
      ]}
    >
      <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 72, bottom: 4, left: 4 }}>
        <CartesianGrid stroke={GRID_COLOR} horizontal={false} />
        <XAxis
          type="number"
          tickFormatter={moneyTick}
          tick={AXIS_STYLE}
          tickLine={false}
          axisLine={{ stroke: GRID_COLOR }}
        />
        <YAxis
          type="category"
          dataKey="label"
          tick={AXIS_STYLE}
          tickLine={false}
          axisLine={false}
          width={128}
        />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value: unknown) => moneyTooltip(value, seriesName)} />
        <Bar
          dataKey="amountCents"
          name={seriesName}
          fill={SERIES_COLORS.expense}
          radius={[0, 3, 3, 0]}
          barSize={22}
          isAnimationActive={false}
          onClick={
            onSelect
              ? (entry: unknown) => {
                  const label = (entry as { label?: unknown } | null)?.label;
                  if (typeof label === "string") onSelect(label);
                }
              : undefined
          }
          cursor={onSelect ? "pointer" : undefined}
        >
          <LabelList
            dataKey="amountCents"
            position="right"
            formatter={(value: unknown) => formatMoney(toCents(value))}
            style={{ fill: "#101828", fontSize: 12, fontWeight: 700 }}
          />
        </Bar>
      </BarChart>
    </ChartFrame>
  );
}

// ─── Utilization donut ───────────────────────────────────────────────────────

/**
 * The 2% utilization visual. Deliberately shows used, pending and remaining as
 * three named parts rather than a single "percent complete" bar, because
 * remaining money is not a failure state.
 */
export function UtilizationDonut({
  usedCents,
  pendingCents,
  remainingCents,
  percentLabel,
  caption,
}: {
  usedCents: Cents;
  pendingCents: Cents;
  remainingCents: Cents;
  percentLabel: string;
  caption: string;
}) {
  const slices = [
    { label: "Spent", value: Math.max(0, usedCents), color: SERIES_COLORS.expense },
    { label: "Pending", value: Math.max(0, pendingCents), color: "#b54708" },
    { label: "Remaining", value: Math.max(0, remainingCents), color: "#d7dbe4" },
  ].filter((slice) => slice.value > 0);

  const total = slices.reduce((sum, slice) => sum + slice.value, 0);

  if (total === 0) {
    return (
      <p className="empty-state">
        No 2% money has been received or spent in this year yet, so there is nothing to chart.
      </p>
    );
  }

  return (
    <div className="fb-an-util">
      <div className="fb-an-util-chart" role="img" aria-label={caption}>
        <ResponsiveContainer width="100%" height={132}>
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="label"
              innerRadius="66%"
              outerRadius="88%"
              startAngle={90}
              endAngle={-270}
              paddingAngle={1}
              stroke="#ffffff"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {slices.map((slice) => (
                <Cell key={slice.label} fill={slice.color} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={moneyTooltip}
            />
            <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle">
              <tspan x="50%" dy="-0.3em" className="fb-an-donut-center-value">
                {percentLabel}
              </tspan>
              <tspan x="50%" dy="1.7em" className="fb-an-donut-center-label">
                used
              </tspan>
            </text>
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="fb-an-util-legend">
        {slices.map((slice) => (
          <li key={slice.label}>
            <span className="fb-an-swatch" style={{ background: slice.color }} aria-hidden="true" />
            <span className="fb-an-util-legend-label">{slice.label}</span>
            <span className="fb-an-util-legend-value">{formatMoney(slice.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
