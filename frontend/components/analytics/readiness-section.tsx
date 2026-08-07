"use client";

/**
 * Documentation, reconciliation and audit readiness.
 *
 * Compact dashboard summary with icon metrics and a clear CTA, matching the
 * mockup. Full exception breakdown lives in the detail drawer.
 */

import { useState, type ReactNode } from "react";

import { STALE_RECONCILIATION_DAYS } from "../../lib/analytics/documentation";
import { formatPercent, formatTimestamp } from "../../lib/analytics/format";
import type { AnalyticsResult } from "../../lib/analytics/engine";
import type { DrilldownTarget } from "../../lib/analytics/types";
import { AlertTriangleIcon, CheckCircleIcon, ReceiptIcon } from "./icons";
import { Drawer, InfoTip, MetricCard, ProgressMeter, StatusPill } from "./primitives";

const AUDIT_DISCLAIMER =
  "Audit Readiness is a recordkeeping completeness indicator based only on what is in Hallix. " +
  "Hallix does not perform an audit and does not issue an audit opinion. It does not determine " +
  "whether the department is compliant with any law or regulation.";

export function ReadinessSection({
  result,
  sectionId,
  onDrilldown,
}: {
  result: AnalyticsResult;
  sectionId: string;
  onDrilldown: (target: DrilldownTarget) => void;
}) {
  const { documentation: docs } = result;
  const [showDetail, setShowDetail] = useState(false);

  return (
    <div id={sectionId} className="card fb-an-section fb-an-section--compact" aria-label="Records and readiness">
      <div className="fb-section-head fb-an-section-head">
        <div>
          <p className="eyebrow">Records readiness</p>
          <h3>
            Documentation and readiness
            <InfoTip text={AUDIT_DISCLAIMER} label="What Audit Readiness means in Hallix" />
          </h3>
        </div>
        <div className="fb-an-readiness-actions">
          <StatusPill level={docs.readiness.level} label={docs.readiness.label} />
          <button
            type="button"
            className="fb-primary-btn fb-an-readiness-cta"
            onClick={() => setShowDetail(true)}
          >
            Review open items
          </button>
        </div>
      </div>

      <div className="fb-an-readiness-metrics">
        <ReadinessMetric
          chipClass="fb-an-icon-chip--green"
          icon={<ReceiptIcon size={14} />}
          label="Receipts on file"
          value={formatPercent(docs.receiptCompletionPercent, 0)}
          tip={
            docs.missingReceiptCount > 0
              ? { count: docs.missingReceiptCount, text: "missing receipts" }
              : null
          }
          onTipClick={() => onDrilldown({ kind: "reconciliation", queue: "missing_receipt" })}
        />
        <ReadinessMetric
          chipClass="fb-an-icon-chip--blue"
          icon={<CheckCircleIcon size={14} />}
          label="Reconciled"
          value={formatPercent(docs.reconciliationCompletionPercent, 0)}
          tip={
            docs.unreconciledCount > 0
              ? { count: docs.unreconciledCount, text: "not reconciled" }
              : null
          }
          onTipClick={() => onDrilldown({ kind: "reconciliation", queue: "unreconciled" })}
        />
        <ReadinessMetric
          chipClass="fb-an-icon-chip--orange"
          icon={<AlertTriangleIcon size={14} />}
          label="Open items"
          value={String(docs.openExceptionCount)}
          valueOut={docs.openExceptionCount > 0}
          tip={
            docs.uncategorizedCount > 0
              ? { count: docs.uncategorizedCount, text: "not categorized" }
              : null
          }
          onTipClick={() => onDrilldown({ kind: "reconciliation", queue: "needs_review" })}
        />
      </div>

      {showDetail ? (
        <Drawer title="Documentation and audit readiness" eyebrow="Records" onClose={() => setShowDetail(false)}>
          {docs.readiness.reasons.length > 0 ? (
            <ul className="fb-an-reason-list">
              {docs.readiness.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              Everything recorded in this period has a receipt, a description, a category and a
              reconciliation.
            </p>
          )}

          <div className="fb-an-readiness-meters">
            <div>
              <p className="fb-an-control-label">
                Receipts on file
                <InfoTip
                  label="How receipt completion is measured"
                  text="The share of expense transactions in this period that have a receipt attached. Income and transfers are not counted, because they do not need one."
                />
              </p>
              <ProgressMeter
                percent={docs.receiptCompletionPercent}
                level={docs.receiptCompletionPercent == null ? "unknown" : docs.readiness.level}
                label={`Receipt completion: ${formatPercent(docs.receiptCompletionPercent, 0)}`}
              />
              <p className="muted">
                {docs.receiptCompletionPercent == null
                  ? "No expenses recorded in this period."
                  : `${docs.withReceiptCount} of ${docs.expenseCount} expenses`}
              </p>
            </div>

            <div>
              <p className="fb-an-control-label">Reconciled</p>
              <ProgressMeter
                percent={docs.reconciliationCompletionPercent}
                level={docs.reconciliationCompletionPercent == null ? "unknown" : docs.readiness.level}
                label={`Reconciliation completion: ${formatPercent(docs.reconciliationCompletionPercent, 0)}`}
              />
              <p className="muted">
                {docs.reconciliationCompletionPercent == null
                  ? "Nothing recorded in this period."
                  : `${docs.reconciledCount} of ${docs.reconciledCount + docs.unreconciledCount} transactions`}
              </p>
            </div>
          </div>

          <div className="fb-metric-grid">
            <MetricCard
              label="Missing receipts"
              value={docs.missingReceiptCount}
              tone={docs.missingReceiptCount > 0 ? "warn" : undefined}
              onClick={() => onDrilldown({ kind: "reconciliation", queue: "missing_receipt" })}
              actionLabel="Missing receipts. Open the receipt queue."
            />
            <MetricCard
              label="No description"
              value={docs.missingDescriptionCount}
              tone={docs.missingDescriptionCount > 0 ? "warn" : undefined}
              hint="Transactions with nothing written about them"
              onClick={() => onDrilldown({ kind: "transactions", filters: { quickFilter: "needs_review" } })}
            />
            <MetricCard
              label="Not categorized"
              value={docs.uncategorizedCount}
              tone={docs.uncategorizedCount > 0 ? "warn" : undefined}
              onClick={() => onDrilldown({ kind: "transactions", filters: { quickFilter: "needs_review" } })}
            />
            <MetricCard
              label="Not reconciled"
              value={docs.unreconciledCount}
              tone={docs.unreconciledCount > 0 ? "warn" : undefined}
              onClick={() => onDrilldown({ kind: "reconciliation", queue: "unreconciled" })}
            />
            <MetricCard
              label={`Open over ${STALE_RECONCILIATION_DAYS} days`}
              value={docs.staleUnreconciledCount}
              tone={docs.staleUnreconciledCount > 0 ? "warn" : undefined}
              hint="Unreconciled and getting old"
              onClick={() => onDrilldown({ kind: "reconciliation", queue: "unreconciled" })}
            />
            <MetricCard
              label="Possible duplicates"
              value={docs.flaggedDuplicateCount}
              tone={docs.flaggedDuplicateCount > 0 ? "warn" : undefined}
              hint="Flagged when the same charge appears twice"
              onClick={() => onDrilldown({ kind: "reconciliation", queue: "duplicate" })}
            />
            <MetricCard
              label="Flagged for review"
              value={docs.needsReviewCount}
              tone={docs.needsReviewCount > 0 ? "warn" : undefined}
              hint="Receipt readings Hallix was unsure about"
              onClick={() => onDrilldown({ kind: "reconciliation", queue: "needs_review" })}
            />
            <MetricCard
              label="Open items total"
              value={docs.openExceptionCount}
              tone={docs.openExceptionCount > 0 ? "warn" : undefined}
              hint="Everything above that is still outstanding"
            />
          </div>

          {docs.accountsNeedingReconciliation.length > 0 ? (
            <>
              <h4 className="fb-an-subheading">Accounts not reconciled recently</h4>
              <div className="table-wrap">
                <table>
                  <caption className="fb-an-visually-hidden">
                    Accounts whose last reconciliation is old or missing
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Account</th>
                      <th scope="col">Last reconciled</th>
                      <th scope="col">Days ago</th>
                      <th scope="col" />
                    </tr>
                  </thead>
                  <tbody>
                    {docs.accountsNeedingReconciliation.map((entry) => (
                      <tr key={entry.account.id}>
                        <th scope="row">{entry.account.name}</th>
                        <td>
                          {entry.lastReconciledAt ? formatTimestamp(entry.lastReconciledAt) : "Never"}
                        </td>
                        <td>{entry.daysSince == null ? "—" : entry.daysSince}</td>
                        <td>
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => onDrilldown({ kind: "reconciliation", queue: "unreconciled" })}
                          >
                            Reconcile
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}

          <p className="muted fb-an-footnote">{AUDIT_DISCLAIMER}</p>
        </Drawer>
      ) : null}
    </div>
  );
}

function ReadinessMetric({
  chipClass,
  icon,
  label,
  value,
  valueOut = false,
  tip,
  onTipClick,
}: {
  chipClass: string;
  icon: ReactNode;
  label: string;
  value: string;
  valueOut?: boolean;
  tip: { count: number; text: string } | null;
  onTipClick: () => void;
}) {
  const tipLabel = tip ? `${tip.count} ${tip.text}` : null;

  const body = (
    <>
      <span className={`fb-an-icon-chip ${chipClass}`} aria-hidden="true">
        {icon}
      </span>
      <div className="fb-an-readiness-metric-copy">
        <p className="fb-an-compact-metric-label">{label}</p>
        <p className={`fb-an-compact-metric-value ${valueOut ? "fb-an-compact-metric-value--out" : ""}`}>
          {value}
        </p>
      </div>
      {tipLabel ? (
        <span className="fb-an-readiness-metric-tip" role="tooltip">
          {tipLabel}
        </span>
      ) : null}
    </>
  );

  if (!tip || !tipLabel) {
    return <div className="fb-an-readiness-metric">{body}</div>;
  }

  return (
    <button
      type="button"
      className="fb-an-readiness-metric fb-an-readiness-metric--tip"
      onClick={onTipClick}
      title={tipLabel}
      aria-label={`${label}: ${value}. ${tipLabel}. Open queue.`}
    >
      {body}
    </button>
  );
}
