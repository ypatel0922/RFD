"use client";

/**
 * Spending and category analytics.
 *
 * Everything here counts real expenses only. Transfers between the
 * department's own accounts and payments made against a credit card are
 * excluded, because neither is money leaving the department.
 *
 * The dashboard card keeps the category donut and the top five categories
 * beside it. "Money in and out by month" lives once, in Cash Flow — not here
 * — so it is never shown twice. Everything else (the full category table,
 * increase/decrease rankings, largest transactions) is in the detail drawer.
 */

import { describeChange, formatMoney, formatPercent, formatSignedMoney } from "../../lib/analytics/format";
import type { AnalyticsResult } from "../../lib/analytics/engine";
import type { DrilldownTarget } from "../../lib/analytics/types";
import { CategoryDonut } from "./charts";
import { AnalyticsSection, Drawer, EmptyState, InfoTip, MetricCard } from "./primitives";
import { useState } from "react";

const TOP_COUNT = 5;

export function SpendingSection({
  result,
  sectionId,
  onDrilldown,
}: {
  result: AnalyticsResult;
  sectionId: string;
  onDrilldown: (target: DrilldownTarget) => void;
}) {
  const { totals, categories, categoriesForChart, categoryIncreases, categoryDecreases } = result;
  const hasSpending = totals.grossExpenseCents > 0 || totals.incomeCents > 0;
  const [showDetail, setShowDetail] = useState(false);
  const topCategories = categories.slice(0, TOP_COUNT);

  const notableChange = categoryIncreases.find(
    (row) => row.change.hasComparison && row.change.percent != null,
  );

  return (
    <AnalyticsSection
      id={sectionId}
      eyebrow="Spending"
      title="Spending overview"
      actions={
        <button type="button" className="fb-an-view-link" onClick={() => setShowDetail(true)}>
          View details
        </button>
      }
    >
      {!hasSpending ? (
        <EmptyState
          title="No spending in this period"
          message="Nothing was recorded between these dates. Widen the date range, or log expenses and import bank activity to see spending here."
        />
      ) : (
        <>
          {notableChange ? (
            <p className="fb-an-callout muted">
              <strong>{notableChange.category}</strong> spending is{" "}
              {describeChange(notableChange.change).toLowerCase()} compared with{" "}
              {result.period.comparisonLabel ?? "the comparison period"}.
            </p>
          ) : null}

          <div className="fb-an-compact-two-col">
            <CategoryDonut
              title="Spending by category"
              slices={categoriesForChart.map((category) => ({
                label: category.category,
                amountCents: category.amountCents,
                percent: category.percentOfTotal,
                count: category.transactionCount,
              }))}
              centerLabel="total out"
              centerValue={formatMoney(totals.expenseCents)}
              emptyMessage="No categorized spending in this period."
              onSelect={(label) => {
                if (label === "Other") return;
                onDrilldown({ kind: "transactions", filters: { category: label } });
              }}
            />

            <ul className="fb-an-top-list">
              {topCategories.map((category) => (
                <li key={category.category} className="fb-an-top-row">
                  <button
                    type="button"
                    className="fb-an-top-row-name"
                    onClick={() => onDrilldown({ kind: "transactions", filters: { category: category.category } })}
                  >
                    {category.category}
                  </button>
                  <span className="fb-an-top-row-meta">
                    <span className="fb-an-top-row-amount">{formatMoney(category.amountCents)}</span>
                    {formatPercent(category.percentOfTotal, 0)}
                    {category.change.hasComparison ? ` · ${describeChange(category.change)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="fb-an-more">
            <button type="button" className="fb-secondary-btn" onClick={() => setShowDetail(true)}>
              View all categories
            </button>
          </div>
        </>
      )}

      {showDetail ? (
        <Drawer title="Spending detail" eyebrow="Spending" onClose={() => setShowDetail(false)}>
          <div className="fb-metric-grid">
            <MetricCard
              label="Money out"
              value={formatMoney(totals.expenseCents)}
              tone="out"
              change={describeChange(result.expenseChange)}
              hint={
                totals.refundCents > 0
                  ? `${formatMoney(totals.grossExpenseCents)} spent, less ${formatMoney(totals.refundCents)} refunded`
                  : "Excludes transfers and credit card payments"
              }
              info="Card purchases count as spending. Moving money between your own accounts, and paying a card balance, do not."
              onClick={() => onDrilldown({ kind: "transactions", filters: { quickFilter: "expenses" } })}
            />
            <MetricCard
              label="Money in"
              value={formatMoney(totals.incomeCents)}
              change={describeChange(result.incomeChange)}
              hint="Deposits and receipts, excluding transfers"
              onClick={() => onDrilldown({ kind: "transactions", filters: { quickFilter: "income" } })}
            />
            <MetricCard
              label="Net for the period"
              value={formatSignedMoney(totals.netCents)}
              tone={totals.netCents < 0 ? "out" : undefined}
              hint="Money in less money out"
            />
            <MetricCard
              label="Refunds and credits"
              value={formatMoney(totals.refundCents)}
              hint="Already subtracted from money out"
              info="A refund reduces the category it came back to rather than being counted as income."
            />
            <MetricCard
              label="Moved between accounts"
              value={formatMoney(totals.internalTransferCents)}
              hint="Not counted as income or spending"
              info="Transfers appear on two accounts. Counting them would double the department's activity, so they are tracked separately."
            />
            <MetricCard
              label="Card payments"
              value={formatMoney(totals.creditCardPaymentCents)}
              hint="Paying down a card, not new spending"
            />
            <MetricCard
              label="Not categorized"
              value={formatMoney(totals.uncategorizedExpenseCents)}
              tone={totals.uncategorizedExpenseCount > 0 ? "warn" : undefined}
              hint={`${totals.uncategorizedExpenseCount} transaction${totals.uncategorizedExpenseCount === 1 ? "" : "s"}`}
              onClick={() => onDrilldown({ kind: "transactions", filters: { quickFilter: "needs_review" } })}
            />
          </div>

          <h4 className="fb-an-subheading">
            Category detail
            <InfoTip
              label="About the category table"
              text="Share is each category's portion of total spending for the period. Change compares it with the comparison period you selected above."
            />
          </h4>
          <div className="table-wrap">
            <table>
              <caption className="fb-an-visually-hidden">Spending by category with comparison</caption>
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Share</th>
                  <th scope="col">Transactions</th>
                  <th scope="col">Change</th>
                  <th scope="col">Missing receipts</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((category) => (
                  <tr key={category.category}>
                    <th scope="row">
                      <button
                        type="button"
                        className="link-button"
                        onClick={() =>
                          onDrilldown({
                            kind: "transactions",
                            filters: { category: category.category },
                          })
                        }
                      >
                        {category.category}
                      </button>
                    </th>
                    <td>{formatMoney(category.amountCents)}</td>
                    <td>{formatPercent(category.percentOfTotal, 0)}</td>
                    <td>{category.transactionCount}</td>
                    <td>{describeChange(category.change)}</td>
                    <td>{category.missingReceiptCount || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {categoryIncreases.length > 0 || categoryDecreases.length > 0 ? (
            <div className="fb-an-change-grid">
              <ChangeList
                title="Biggest increases"
                rows={categoryIncreases}
                emptyMessage="No category rose materially."
                onDrilldown={onDrilldown}
              />
              <ChangeList
                title="Biggest decreases"
                rows={categoryDecreases}
                emptyMessage="No category fell materially."
                onDrilldown={onDrilldown}
              />
            </div>
          ) : null}

          <h4 className="fb-an-subheading">Largest transactions</h4>
          {result.topTransactions.length === 0 ? (
            <p className="empty-state">No expenses recorded in this period.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <caption className="fb-an-visually-hidden">
                  The largest individual expenses in this period
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Paid to</th>
                    <th scope="col">Category</th>
                    <th scope="col">Account</th>
                    <th scope="col">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {result.topTransactions.map((transaction) => (
                    <tr key={transaction.id}>
                      <td>{transaction.date ?? "—"}</td>
                      <th scope="row">{transaction.vendor || "Not recorded"}</th>
                      <td>{transaction.category || "Not categorized"}</td>
                      <td>{transaction.accountName || "—"}</td>
                      <td>{formatMoney(transaction.magnitudeCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Drawer>
      ) : null}
    </AnalyticsSection>
  );
}

function ChangeList({
  title,
  rows,
  emptyMessage,
  onDrilldown,
}: {
  title: string;
  rows: AnalyticsResult["categoryIncreases"];
  emptyMessage: string;
  onDrilldown: (target: DrilldownTarget) => void;
}) {
  return (
    <div className="fb-an-change-card">
      <h4 className="fb-an-chart-title">{title}</h4>
      {rows.length === 0 ? (
        <p className="muted">{emptyMessage}</p>
      ) : (
        <ul className="fb-an-inline-facts">
          {rows.map((row) => (
            <li key={row.category}>
              <button
                type="button"
                className="link-button"
                onClick={() =>
                  onDrilldown({ kind: "transactions", filters: { category: row.category } })
                }
              >
                {row.category}
              </button>
              <strong>{describeChange(row.change)}</strong>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
