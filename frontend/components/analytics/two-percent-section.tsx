"use client";

/**
 * 2% Fund Intelligence.
 *
 * Utilization is presented as a department planning figure measured against a
 * target the department chooses. Hallix does not assert that unspent 2% money
 * must be spent by any date, because that depends on the department's own
 * structure and any special law that applies to it.
 *
 * The dashboard card keeps the donut and the handful of figures a chief asks
 * about first. Carryover math, the basis toggle, the department target, the
 * full readiness breakdown and the category table all live in one detail
 * drawer, opened from any of the three actions below the donut.
 */

import { useState } from "react";

import {
  TWO_PERCENT_BASIS_LABELS,
  TWO_PERCENT_DISCLAIMER,
  twoPercentSpendPaceStatus,
} from "../../lib/analytics/two-percent";
import {
  formatMoney,
  formatPercent,
  formatSignedMoney,
  formatTimestamp,
} from "../../lib/analytics/format";
import { FUND_TYPE_OPTIONS } from "../../lib/analytics/accounts";
import type { AnalyticsResult } from "../../lib/analytics/engine";
import type {
  ClassifiedAccount,
  DrilldownTarget,
  TwoPercentBasis,
} from "../../lib/analytics/types";
import { UtilizationDonut } from "./charts";
import {
  AnalyticsSection,
  Drawer,
  EmptyState,
  InfoTip,
  MetricCard,
  ProgressMeter,
  StatusPill,
} from "./primitives";

export function TwoPercentSection({
  result,
  sectionId,
  canManage,
  accounts,
  basis,
  targetPercent,
  isSavingSettings,
  onBasisChange,
  onTargetChange,
  onDesignateAccount,
  onDrilldown,
}: {
  result: AnalyticsResult;
  sectionId: string;
  canManage: boolean;
  accounts: ClassifiedAccount[];
  basis: TwoPercentBasis;
  targetPercent: number;
  isSavingSettings: boolean;
  onBasisChange: (basis: TwoPercentBasis) => void;
  onTargetChange: (percent: number) => void;
  onDesignateAccount: (accountId: string) => void;
  onDrilldown: (target: DrilldownTarget) => void;
}) {
  const summary = result.twoPercent;
  const [showDetail, setShowDetail] = useState(false);

  const disclaimer = (
    <InfoTip text={TWO_PERCENT_DISCLAIMER} label="About 2% fund recordkeeping in Hallix" />
  );

  if (summary == null) {
    return (
      <AnalyticsSection
        id={sectionId}
        eyebrow="New York"
        title="2% Fund Intelligence"
        description={<>Tracking of foreign fire insurance (2%) money. {disclaimer}</>}
      >
        <TwoPercentSetup
          accounts={accounts}
          canManage={canManage}
          isSaving={isSavingSettings}
          onDesignateAccount={onDesignateAccount}
        />
      </AnalyticsSection>
    );
  }

  const pace = twoPercentSpendPaceStatus(summary);
  const topCategories = result.twoPercentCategories.slice(0, 3);

  return (
    <AnalyticsSection
      id={sectionId}
      eyebrow="New York"
      title="2% Fund Intelligence"
      description={<>Foreign fire insurance money for {summary.reportYear}. {disclaimer}</>}
      actions={
        <button type="button" className="fb-an-view-link" onClick={() => setShowDetail(true)}>
          View details
        </button>
      }
    >
      {summary.setupState === "configured_no_activity" ? (
        <EmptyState
          title="No 2% activity recorded for this year"
          message={`The department has identified ${summary.accounts.map((account) => account.name).join(", ")} as its 2% account, but no 2% receipts or expenses have been recorded for ${summary.reportYear} yet.`}
        />
      ) : (
        <div className="fb-an-compact-two-col">
          <div className="fb-an-two-visual">
            <UtilizationDonut
              usedCents={summary.expendituresCents}
              pendingCents={summary.pendingCents}
              remainingCents={Math.max(
                0,
                (summary.denominatorCents ?? 0) - summary.expendituresCents - summary.pendingCents,
              )}
              percentLabel={
                summary.utilizationPercent == null ? "—" : formatPercent(summary.utilizationPercent, 0)
              }
              caption={`${formatPercent(summary.utilizationPercent, 0)} of ${TWO_PERCENT_BASIS_LABELS[summary.basis].toLowerCase()} used in ${summary.reportYear}.`}
            />
          </div>

          <div className="fb-an-two-figures">
            <div className="fb-an-compact-metrics">
              <CompactMetric
                label={`Received in ${summary.reportYear}`}
                value={formatMoney(summary.receiptsCents)}
              />
              <CompactMetric label={`Spent in ${summary.reportYear}`} value={formatMoney(summary.expendituresCents)} out />
              <CompactMetric
                label="Still available"
                value={summary.availableCents == null ? "—" : formatMoney(summary.availableCents)}
              />
              <CompactMetric
                label="Projected year-end"
                value={
                  summary.projectedUtilizationPercent == null
                    ? "Insufficient data"
                    : formatPercent(summary.projectedUtilizationPercent, 0)
                }
              />
            </div>

            {topCategories.length > 0 ? (
              <ul className="fb-an-top-list">
                {topCategories.map((row) => (
                  <li key={row.category} className="fb-an-top-row">
                    <button
                      type="button"
                      className="fb-an-top-row-name"
                      onClick={() =>
                        onDrilldown({
                          kind: "transactions",
                          filters: { category: row.category, quickFilter: "two_percent" },
                        })
                      }
                    >
                      {row.category}
                    </button>
                    <span className="fb-an-top-row-meta">
                      <span className="fb-an-top-row-amount">{formatMoney(row.amountCents)}</span>
                      {formatPercent(row.percentOfExpenditures, 0)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="fb-an-more">
              {summary.readiness.openItemCount > 0 ? (
                <button type="button" className="fb-secondary-btn" onClick={() => setShowDetail(true)}>
                  Review {summary.readiness.openItemCount} open item
                  {summary.readiness.openItemCount === 1 ? "" : "s"}
                </button>
              ) : null}
              {canManage ? (
                <button
                  type="button"
                  className="fb-secondary-btn"
                  aria-label="2% settings: utilization basis and department target"
                  onClick={() => setShowDetail(true)}
                >
                  Settings
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {showDetail ? (
        <Drawer title="2% Fund Intelligence" eyebrow="Full detail" onClose={() => setShowDetail(false)}>
          <fieldset className="fb-an-basis">
            <legend className="fb-an-control-label">Measure utilization against</legend>
            <div className="fb-chip-row" role="group">
              {(Object.keys(TWO_PERCENT_BASIS_LABELS) as TwoPercentBasis[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`fb-chip ${basis === option ? "fb-chip-active" : ""}`}
                  aria-pressed={basis === option}
                  onClick={() => onBasisChange(option)}
                >
                  {TWO_PERCENT_BASIS_LABELS[option]}
                </button>
              ))}
            </div>
            <p className="muted fb-an-basis-note">
              {basis === "total_available"
                ? "Everything the department had available this year: the balance carried in on 1 January plus what it received during the year."
                : "Only what the department received during this year. Money carried in from prior years is left out of the denominator."}
            </p>
          </fieldset>

          <div className="fb-an-target">
            <label className="fb-an-control-label" htmlFor="fb-an-target-input">
              Department target
              <InfoTip
                label="About the department target"
                text="A planning figure the department sets for itself. It is not a legal requirement, and Hallix does not treat unspent money as a failure."
              />
            </label>
            <div className="fb-an-target-row">
              <input
                id="fb-an-target-input"
                type="number"
                min={0}
                max={100}
                step={5}
                value={targetPercent}
                disabled={!canManage || isSavingSettings}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next)) onTargetChange(Math.max(0, Math.min(100, next)));
                }}
              />
              <span aria-hidden="true">%</span>
              {!canManage ? (
                <span className="muted">Only department administrators can change this.</span>
              ) : null}
            </div>
            <ProgressMeter
              percent={summary.utilizationPercent}
              level={pace.level}
              label={`Utilization against the department target of ${targetPercent}%`}
              markerPercent={targetPercent}
              markerLabel={`Department target ${targetPercent}%`}
            />
            <p className="fb-an-pace">
              <StatusPill level={pace.level} label={pace.label} size="small" />
              <span>{pace.explanation}</span>
            </p>
          </div>

          <h4 className="fb-an-subheading">Where this year is heading</h4>
          <p className="muted">
            Estimated by continuing the department's average monthly 2% spending through the end of
            the year. It is a projection, not a commitment.
          </p>
          <ul className="fb-an-inline-facts">
            <li>
              <span>Carried in from prior years</span>
              <strong>{summary.carryoverCents == null ? "—" : formatMoney(summary.carryoverCents)}</strong>
            </li>
            <li>
              <span>Average spent per month</span>
              <strong>{formatMoney(summary.monthlyAverageSpendCents)}</strong>
            </li>
            <li>
              <span>To reach target each remaining month</span>
              <strong>
                {summary.neededPerRemainingMonthCents == null
                  ? "—"
                  : formatMoney(summary.neededPerRemainingMonthCents)}
              </strong>
            </li>
            <li>
              <span>Projected spend by year end</span>
              <strong>
                {summary.projectedYearEndSpendCents == null
                  ? "—"
                  : formatMoney(summary.projectedYearEndSpendCents)}
              </strong>
            </li>
            <li>
              <span>Projected balance at year end</span>
              <strong>
                {summary.projectedYearEndBalanceCents == null
                  ? "—"
                  : formatMoney(summary.projectedYearEndBalanceCents)}
              </strong>
            </li>
            <li>
              <span>Pending</span>
              <strong>{formatMoney(summary.pendingCents)}</strong>
            </li>
          </ul>

          <h4 className="fb-an-subheading">Annual report readiness</h4>
          <div className="fb-an-readiness-row">
            <StatusPill level={summary.readiness.level} label={summary.readiness.label} />
            <span className="muted">
              {summary.readiness.openItemCount === 0
                ? `All ${summary.transactionCount} 2% transactions for ${summary.reportYear} have a receipt, a category and a reconciliation.`
                : `${summary.readiness.openItemCount} item${summary.readiness.openItemCount === 1 ? "" : "s"} to tidy up before the annual report.`}
            </span>
          </div>
          <div className="fb-metric-grid fb-an-grid--compact">
            <MetricCard
              label="Missing receipts"
              value={summary.missingReceiptCount}
              tone={summary.missingReceiptCount > 0 ? "warn" : undefined}
              onClick={() => onDrilldown({ kind: "transactions", filters: { quickFilter: "two_percent" } })}
            />
            <MetricCard
              label="Not categorized"
              value={summary.uncategorizedCount}
              tone={summary.uncategorizedCount > 0 ? "warn" : undefined}
              onClick={() => onDrilldown({ kind: "transactions", filters: { quickFilter: "two_percent" } })}
            />
            <MetricCard
              label="Not reconciled"
              value={summary.unreconciledCount}
              tone={summary.unreconciledCount > 0 ? "warn" : undefined}
              onClick={() => onDrilldown({ kind: "reconciliation", queue: "unreconciled" })}
            />
            <MetricCard
              label="Last reconciled"
              value={summary.lastReconciledAt ? formatTimestamp(summary.lastReconciledAt) : "Never"}
            />
          </div>
          {summary.readiness.reasons.length > 0 ? (
            <ul className="fb-an-reason-list">
              {summary.readiness.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}

          <h4 className="fb-an-subheading">What 2% money was spent on</h4>
          {result.twoPercentCategories.length === 0 ? (
            <EmptyState
              title="No 2% spending categorized yet"
              message={`Nothing has been recorded against the 2% account for ${summary.reportYear}, so there is no category breakdown to show.`}
            />
          ) : (
            <div className="table-wrap">
              <table>
                <caption className="fb-an-visually-hidden">
                  2% expenditures by category for {summary.reportYear}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Category</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Share</th>
                    <th scope="col">Transactions</th>
                    <th scope="col">Change</th>
                    <th scope="col">Missing documents</th>
                  </tr>
                </thead>
                <tbody>
                  {result.twoPercentCategories.map((row) => (
                    <tr key={row.category}>
                      <th scope="row">
                        <button
                          type="button"
                          className="link-button"
                          onClick={() =>
                            onDrilldown({
                              kind: "transactions",
                              filters: { category: row.category, quickFilter: "two_percent" },
                            })
                          }
                        >
                          {row.category}
                        </button>
                      </th>
                      <td>{formatMoney(row.amountCents)}</td>
                      <td>{formatPercent(row.percentOfExpenditures, 0)}</td>
                      <td>{row.transactionCount}</td>
                      <td>{row.changeCents == null ? "No comparison" : formatSignedMoney(row.changeCents)}</td>
                      <td>{row.missingDocumentationCount}</td>
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

function CompactMetric({ label, value, out }: { label: string; value: string; out?: boolean }) {
  return (
    <div className="fb-an-compact-metric">
      <p className="fb-an-compact-metric-label">{label}</p>
      <p className={`fb-an-compact-metric-value ${out ? "fb-an-compact-metric-value--out" : ""}`}>{value}</p>
    </div>
  );
}

/**
 * Shown when no account has been designated as the department's 2% account.
 *
 * Hallix never guesses this from an account's name — "2%" or "foreign fire" in
 * a nickname is not evidence — so an authorized officer confirms it once.
 */
function TwoPercentSetup({
  accounts,
  canManage,
  isSaving,
  onDesignateAccount,
}: {
  accounts: ClassifiedAccount[];
  canManage: boolean;
  isSaving: boolean;
  onDesignateAccount: (accountId: string) => void;
}) {
  const [selected, setSelected] = useState("");

  if (accounts.length === 0) {
    return (
      <EmptyState
        title="No accounts set up yet"
        message="Add the department's bank accounts in Settings, then come back here to identify which one holds 2% money."
      />
    );
  }

  return (
    <div className="fb-an-setup">
      <p className="fb-an-setup-title">Which account holds the department's 2% money?</p>
      <p className="muted">
        Hallix will not assume this from an account's name. Once an officer confirms it, every 2%
        figure on this page follows that designation. The account keeps working exactly as it does
        now — this only records what the money is.
      </p>

      {canManage ? (
        <div className="fb-an-setup-row">
          <label className="fb-an-visually-hidden" htmlFor="fb-an-two-account">
            2% account
          </label>
          <select
            id="fb-an-two-account"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">Choose an account…</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="fb-primary-btn"
            disabled={!selected || isSaving}
            onClick={() => onDesignateAccount(selected)}
          >
            {isSaving ? "Saving…" : "Mark as the 2% account"}
          </button>
        </div>
      ) : (
        <p className="notice">
          Ask a department administrator to identify the 2% account so this section can be filled
          in.
        </p>
      )}

      <p className="muted fb-an-footnote">
        Recognized fund designations: {FUND_TYPE_OPTIONS.map((option) => option.label).join(", ")}.
      </p>
    </div>
  );
}
