"use client";

/**
 * Cash and accounts.
 *
 * Accounts are treated by their accounting nature: assets add to cash,
 * liabilities are subtracted. A card balance is never shown as cash, and paying
 * a card is never shown as spending.
 *
 * The dashboard card shows the headline cash figures, a small balance trend,
 * and only the accounts that need attention. The full account-by-account
 * table, and the classification form, live in the detail drawer.
 */

import { useState } from "react";

import {
  ACCOUNT_KIND_LABELS,
  ACCOUNT_TYPE_OPTIONS,
  FUND_LABELS,
  FUND_TYPE_OPTIONS,
} from "../../lib/analytics/accounts";
import { formatIsoDate, formatMoney, formatTimestamp } from "../../lib/analytics/format";
import type { AccountActivity } from "../../lib/analytics/aggregate";
import type { AnalyticsResult } from "../../lib/analytics/engine";
import type { ClassifiedAccount, DrilldownTarget, StatusLevel } from "../../lib/analytics/types";
import { BalanceTrendChart } from "./charts";
import { AnalyticsSection, Drawer, EmptyState, InfoTip, StatusPill } from "./primitives";

export function AccountsSection({
  result,
  sectionId,
  canManage,
  savingAccountId,
  onClassifyAccount,
  onDrilldown,
}: {
  result: AnalyticsResult;
  sectionId: string;
  canManage: boolean;
  savingAccountId: string | null;
  onClassifyAccount: (account: ClassifiedAccount, accountType: string, fundType: string) => void;
  onDrilldown: (target: DrilldownTarget) => void;
}) {
  const { cash, accountActivity: activity, cashFlow } = result;
  const unclassified = activity.filter((row) => row.account.kind === "unclassified");
  const [showDetail, setShowDetail] = useState(false);
  const [showClassify, setShowClassify] = useState(false);

  const needingAttention = activity.filter((row) => accountStatus(row) !== "positive");

  return (
    <AnalyticsSection
      id={sectionId}
      eyebrow="Accounts"
      title="Cash position"
      actions={
        <button type="button" className="fb-an-view-link" onClick={() => setShowDetail(true)}>
          View details
        </button>
      }
    >
      {!result.hasAccounts ? (
        <EmptyState
          title="No accounts connected yet"
          message="Add the department's bank accounts in Settings, or connect them through the bank import, and balances will appear here."
        />
      ) : (
        <>
          <div className="fb-an-cash-grid">
            <CompactMetric label="Cash and savings" value={formatMoney(cash.totalCashCents)} />
            <CompactMetric
              label="Owed on cards"
              value={formatMoney(cash.creditCardBalanceCents)}
              out={cash.creditCardBalanceCents > 0}
            />
            <CompactMetric label="Available after cards" value={formatMoney(cash.netLiquidCents)} />
            <CompactMetric
              label="Accounts needing attention"
              value={String(needingAttention.length)}
              out={needingAttention.length > 0}
            />
          </div>

          <div className="fb-an-cash-chart">
            <BalanceTrendChart
              title="Balance over time (last 12 months)"
              points={cashFlow.months
                .filter((month) => month.balanceCents != null)
                .map((month) => ({ monthKey: month.monthKey, balanceCents: month.balanceCents as number }))}
              emptyMessage="A balance trend needs a recorded starting balance on at least one account."
            />
          </div>

          {unclassified.length > 0 ? (
            <div className="notice fb-an-classify-alert">
              <p>
                {unclassified.length} account{unclassified.length === 1 ? "" : "s"} need
                {unclassified.length === 1 ? "s" : ""} classification to complete these analytics.
              </p>
              {canManage ? (
                <button type="button" className="fb-secondary-btn" onClick={() => setShowClassify(true)}>
                  Classify account{unclassified.length === 1 ? "" : "s"}
                </button>
              ) : (
                <span className="muted">Ask a department administrator to set the account types.</span>
              )}
            </div>
          ) : null}
        </>
      )}

      {showClassify ? (
        <Drawer title="Classify accounts" eyebrow="Accounts" onClose={() => setShowClassify(false)}>
          <p className="muted">
            Until Hallix knows whether an account is cash or a credit card, it is left out of the
            totals above rather than guessed at.
          </p>
          <ul className="fb-an-classify-list">
            {unclassified.map((row) => (
              <AccountClassifier
                key={row.account.id}
                account={row.account}
                isSaving={savingAccountId === row.account.id}
                onSave={onClassifyAccount}
              />
            ))}
          </ul>
        </Drawer>
      ) : null}

      {showDetail ? (
        <Drawer title="All accounts" eyebrow="Accounts" onClose={() => setShowDetail(false)}>
          <div className="fb-an-compact-metrics">
            <CompactMetric label="Cash and savings" value={formatMoney(cash.totalCashCents)} />
            <CompactMetric label="Operating cash" value={formatMoney(cash.operatingCashCents)} />
            <CompactMetric label="Designated or restricted" value={formatMoney(cash.designatedCashCents)} />
            <CompactMetric label="Owed on cards" value={formatMoney(cash.creditCardBalanceCents)} out={cash.creditCardBalanceCents > 0} />
          </div>

          <h4 className="fb-an-subheading">Account by account</h4>
          <div className="table-wrap">
            <table>
              <caption className="fb-an-visually-hidden">
                Balances, activity and reconciliation status for each account
              </caption>
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Type</th>
                  <th scope="col">Balance</th>
                  <th scope="col">In</th>
                  <th scope="col">Out</th>
                  <th scope="col">Last reconciled</th>
                  <th scope="col">Needs attention</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {activity.map((row) => (
                  <tr key={row.account.id}>
                    <th scope="row">
                      <button
                        type="button"
                        className="link-button"
                        onClick={() =>
                          onDrilldown({
                            kind: "transactions",
                            filters: { accountName: row.account.name },
                          })
                        }
                      >
                        {row.account.name}
                      </button>
                      {row.account.isTwoPercent ? (
                        <span className="fb-settings-inline-pill">2% fund</span>
                      ) : row.account.fund !== "operating" && row.account.fund !== "unspecified" ? (
                        <span className="fb-settings-inline-pill">{FUND_LABELS[row.account.fund]}</span>
                      ) : null}
                    </th>
                    <td>
                      {row.account.kindLabel || ACCOUNT_KIND_LABELS[row.account.kind]}
                      {row.account.kind === "unclassified" ? (
                        <InfoTip
                          label={`Why ${row.account.name} has no type`}
                          text="No account type has been recorded, so Hallix cannot tell whether this is cash or a card. It is excluded from the totals until someone says which it is."
                        />
                      ) : null}
                    </td>
                    <td>
                      {row.balanceCents == null ? (
                        <span className="muted">Not established</span>
                      ) : (
                        formatMoney(row.balanceCents)
                      )}
                      {row.balanceSource === "opening_plus_activity" ? (
                        <InfoTip
                          label={`How the ${row.account.name} balance was calculated`}
                          text="Recorded opening balance plus everything logged since. It has not been checked against a bank statement."
                        />
                      ) : null}
                    </td>
                    <td>{formatMoney(row.depositsCents)}</td>
                    <td>{formatMoney(row.withdrawalsCents)}</td>
                    <td>
                      {row.account.lastReconciledAt
                        ? formatTimestamp(row.account.lastReconciledAt)
                        : "Never"}
                    </td>
                    <td>
                      <AttentionCell row={row} onDrilldown={onDrilldown} />
                    </td>
                    <td>
                      <StatusPill level={accountStatus(row)} label={accountStatusLabel(row)} size="small" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

function AttentionCell({
  row,
  onDrilldown,
}: {
  row: AccountActivity;
  onDrilldown: (target: DrilldownTarget) => void;
}) {
  const parts: string[] = [];
  if (row.unreconciledCount > 0) parts.push(`${row.unreconciledCount} unreconciled`);
  if (row.missingReceiptCount > 0) parts.push(`${row.missingReceiptCount} missing receipts`);
  if (row.pendingImportedCount > 0) parts.push(`${row.pendingImportedCount} pending`);

  if (parts.length === 0) return <span className="muted">Nothing outstanding</span>;

  return (
    <button
      type="button"
      className="link-button"
      onClick={() => onDrilldown({ kind: "reconciliation", queue: "unreconciled" })}
    >
      {parts.join(" · ")}
    </button>
  );
}

function accountStatus(row: AccountActivity): StatusLevel {
  if (row.account.kind === "unclassified") return "unknown";
  if (row.account.kind === "asset" && row.balanceCents != null && row.balanceCents < 0) return "risk";
  if (row.unreconciledCount > 0 || row.missingReceiptCount > 0) return "attention";
  if (row.balanceCents == null) return "unknown";
  return "positive";
}

function accountStatusLabel(row: AccountActivity): string {
  if (row.account.kind === "unclassified") return "Needs a type";
  if (row.account.kind === "asset" && row.balanceCents != null && row.balanceCents < 0) {
    return "Negative balance";
  }
  if (row.unreconciledCount > 0) return "Reconcile";
  if (row.missingReceiptCount > 0) return "Add receipts";
  if (row.balanceCents == null) return "No balance yet";
  return "Up to date";
}

/**
 * Lets an officer record what an account actually is. This writes only to the
 * account's own type and fund fields; it does not touch balances, transactions
 * or the account-management screen.
 */
function AccountClassifier({
  account,
  isSaving,
  onSave,
}: {
  account: ClassifiedAccount;
  isSaving: boolean;
  onSave: (account: ClassifiedAccount, accountType: string, fundType: string) => void;
}) {
  const typeId = `fb-an-type-${account.id}`;
  const fundId = `fb-an-fund-${account.id}`;

  return (
    <li className="fb-an-classify-row">
      <span className="fb-an-classify-name">{account.name}</span>
      <label className="fb-an-visually-hidden" htmlFor={typeId}>
        Account type for {account.name}
      </label>
      <select id={typeId} defaultValue="" disabled={isSaving}>
        <option value="">Account type…</option>
        {ACCOUNT_TYPE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.value}
          </option>
        ))}
      </select>
      <label className="fb-an-visually-hidden" htmlFor={fundId}>
        Fund designation for {account.name}
      </label>
      <select id={fundId} defaultValue="" disabled={isSaving}>
        <option value="">Fund (optional)…</option>
        {FUND_TYPE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="fb-secondary-btn"
        disabled={isSaving}
        onClick={() => {
          const type = (document.getElementById(typeId) as HTMLSelectElement | null)?.value ?? "";
          const fund = (document.getElementById(fundId) as HTMLSelectElement | null)?.value ?? "";
          if (!type) return;
          onSave(account, type, fund);
        }}
      >
        {isSaving ? "Saving…" : "Save"}
      </button>
      {account.lastReconciledAt ? (
        <span className="muted">Last reconciled {formatIsoDate(account.lastReconciledAt)}</span>
      ) : null}
    </li>
  );
}
