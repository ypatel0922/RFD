"use client";

/**
 * Vendor analytics.
 *
 * This is where the old Vendors tab now lives. It keeps everything that page
 * showed — name, transaction count, total spend, top category, last activity —
 * and adds the comparison, documentation and drill-down that the standalone
 * page could not offer. Vendor records themselves are untouched.
 *
 * The dashboard card shows the top five vendors by spend as a horizontal bar
 * chart with totals on each bar. Search, sort, filter and the full table live
 * behind "View all vendors", in the same detail drawer every other section uses.
 */

import { useMemo, useState } from "react";

import { describeChange, formatIsoDate, formatMoney, formatPercent } from "../../lib/analytics/format";
import { monthKey } from "../../lib/analytics/date-range";
import { vendorKeyFor, type VendorTotal } from "../../lib/analytics/aggregate";
import type { AnalyticsResult } from "../../lib/analytics/engine";
import type { AnalyticsTransaction, DrilldownTarget } from "../../lib/analytics/types";
import { RankedBarChart, SpendTrendChart } from "./charts";
import { AnalyticsSection, Drawer, EmptyState, MetricCard, StatusPill } from "./primitives";

type VendorSort = "spend" | "count" | "recent" | "name";

const SORT_OPTIONS: Array<{ id: VendorSort; label: string }> = [
  { id: "spend", label: "Total spend" },
  { id: "count", label: "Most used" },
  { id: "recent", label: "Most recent" },
  { id: "name", label: "Name A–Z" },
];

const TOP_COUNT = 5;

export function VendorsSection({
  result,
  sectionId,
  selectedVendorKey,
  onSelectVendor,
  onDrilldown,
}: {
  result: AnalyticsResult;
  sectionId: string;
  selectedVendorKey: string | null;
  onSelectVendor: (vendorKey: string | null) => void;
  onDrilldown: (target: DrilldownTarget) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const topVendors = result.vendors.slice(0, TOP_COUNT);
  const selectedVendor = result.vendors.find((vendor) => vendor.key === selectedVendorKey) ?? null;

  return (
    <AnalyticsSection
      id={sectionId}
      eyebrow="Vendors"
      title="Top vendors by spend"
      actions={
        <button type="button" className="fb-an-view-link" onClick={() => setShowAll(true)}>
          View all vendors
        </button>
      }
    >
      {result.vendors.length === 0 ? (
        <EmptyState
          title="No vendor spending in this period"
          message="Vendors appear from logged expenses and imported bank activity. Widen the date range, or record an expense, and they will show up here."
        />
      ) : (
        <RankedBarChart
          title=""
          rows={topVendors.map((vendor) => ({ label: vendor.name, amountCents: vendor.totalSpendCents }))}
          emptyMessage="No vendor spending in this period."
          height={200}
          onSelect={(label) => {
            const vendor = topVendors.find((entry) => entry.name === label);
            if (vendor) onSelectVendor(vendor.key);
          }}
        />
      )}

      {result.vendorsWithoutActivity.length > 0 ? (
        <details className="fb-an-known-vendors">
          <summary>
            {result.vendorsWithoutActivity.length} vendor
            {result.vendorsWithoutActivity.length === 1 ? "" : "s"} on record with no spending in
            this period
          </summary>
          <p className="muted">
            These are saved in the department's vendor list — from onboarding or from an accepted
            suggestion — but nothing was paid to them between these dates.
          </p>
          <ul className="fb-an-budget-chips">
            {result.vendorsWithoutActivity.map((vendor) => (
              <li key={vendor.name}>
                <span>
                  {vendor.name}
                  {vendor.defaultCategory ? ` — ${vendor.defaultCategory}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {showAll ? (
        <VendorTableDrawer result={result} onClose={() => setShowAll(false)} onSelectVendor={onSelectVendor} />
      ) : null}

      {selectedVendor ? (
        <VendorDrawer
          vendor={selectedVendor}
          transactions={result.currentTransactions}
          comparisonLabel={result.period.comparisonLabel}
          onClose={() => onSelectVendor(null)}
          onDrilldown={onDrilldown}
        />
      ) : null}
    </AnalyticsSection>
  );
}

/** The full searchable, sortable, filterable vendor table, in the shared detail drawer. */
function VendorTableDrawer({
  result,
  onClose,
  onSelectVendor,
}: {
  result: AnalyticsResult;
  onClose: () => void;
  onSelectVendor: (vendorKey: string | null) => void;
}) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<VendorSort>("spend");
  const [category, setCategory] = useState("");
  const [accountName, setAccountName] = useState("");

  const categoryOptions = useMemo(
    () => [...new Set(result.vendors.flatMap((vendor) => vendor.topCategories.map((entry) => entry.category)))].sort(),
    [result.vendors],
  );
  const accountOptions = useMemo(
    () =>
      [...new Set(result.vendors.map((vendor) => vendor.topAccountName).filter((name): name is string => Boolean(name)))].sort(),
    [result.vendors],
  );

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = result.vendors.filter((vendor) => {
      if (query && !vendor.name.toLowerCase().includes(query)) return false;
      if (category && !vendor.topCategories.some((entry) => entry.category === category)) return false;
      if (accountName && vendor.topAccountName !== accountName) return false;
      return true;
    });

    const sorted = [...filtered];
    if (sort === "count") sorted.sort((a, b) => b.transactionCount - a.transactionCount);
    else if (sort === "recent") sorted.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
    else if (sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
    else sorted.sort((a, b) => b.totalSpendCents - a.totalSpendCents);
    return sorted;
  }, [result.vendors, search, sort, category, accountName]);

  return (
    <Drawer title="All vendors" eyebrow="Vendors" onClose={onClose}>
      <div className="fb-an-vendor-toolbar">
        <div className="fb-an-vendor-search">
          <label htmlFor="fb-an-vendor-search" className="fb-an-control-label">
            Search vendors
          </label>
          <input
            id="fb-an-vendor-search"
            type="search"
            value={search}
            placeholder="Vendor name"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <div className="fb-an-vendor-filter">
          <label htmlFor="fb-an-vendor-category" className="fb-an-control-label">
            Category
          </label>
          <select id="fb-an-vendor-category" value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">All categories</option>
            {categoryOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        <div className="fb-an-vendor-filter">
          <label htmlFor="fb-an-vendor-account" className="fb-an-control-label">
            Account
          </label>
          <select id="fb-an-vendor-account" value={accountName} onChange={(event) => setAccountName(event.target.value)}>
            <option value="">All accounts</option>
            {accountOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="fb-an-vendor-sort">
          <legend className="fb-an-control-label">Sort by</legend>
          <div className="fb-chip-row" role="group">
            {SORT_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`fb-chip ${sort === option.id ? "fb-chip-active" : ""}`}
                aria-pressed={sort === option.id}
                onClick={() => setSort(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      <p className="muted" role="status">
        Showing {rows.length} of {result.vendors.length} vendors.
      </p>

      {rows.length === 0 ? (
        <p className="empty-state">No vendor matches those filters.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="fb-an-visually-hidden">Vendor spending for the selected period</caption>
            <thead>
              <tr>
                <th scope="col">Vendor</th>
                <th scope="col">Total spend</th>
                <th scope="col">Transactions</th>
                <th scope="col">Average</th>
                <th scope="col">Share</th>
                <th scope="col">Top category</th>
                <th scope="col">Last activity</th>
                <th scope="col">Change</th>
                <th scope="col">Missing receipts</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((vendor) => (
                <tr key={vendor.key}>
                  <th scope="row">
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => onSelectVendor(vendor.key)}
                      aria-haspopup="dialog"
                    >
                      {vendor.name}
                    </button>
                  </th>
                  <td>{formatMoney(vendor.totalSpendCents)}</td>
                  <td>{vendor.transactionCount}</td>
                  <td>{formatMoney(vendor.averageCents)}</td>
                  <td>{formatPercent(vendor.percentOfSpend, 0)}</td>
                  <td>{vendor.topCategories[0]?.category ?? "Not categorized"}</td>
                  <td>{formatIsoDate(vendor.lastActivity)}</td>
                  <td>{describeChange(vendor.change)}</td>
                  <td>
                    {vendor.missingReceiptCount > 0 ? (
                      <StatusPill level="attention" label={String(vendor.missingReceiptCount)} size="small" />
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Drawer>
  );
}

/** Vendor detail. Opens over the analytics context the officer was already looking at. */
function VendorDrawer({
  vendor,
  transactions,
  comparisonLabel,
  onClose,
  onDrilldown,
}: {
  vendor: VendorTotal;
  transactions: AnalyticsTransaction[];
  comparisonLabel: string | null;
  onClose: () => void;
  onDrilldown: (target: DrilldownTarget) => void;
}) {
  const vendorTransactions = useMemo(
    () =>
      transactions
        .filter(
          (transaction) =>
            transaction.classification === "expense" &&
            vendorKeyFor(transaction.vendor) === vendor.key,
        )
        .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")),
    [transactions, vendor.key],
  );

  const trend = useMemo(() => {
    const buckets = new Map<string, number>();
    for (const transaction of vendorTransactions) {
      if (!transaction.date) continue;
      const key = monthKey(transaction.date);
      buckets.set(key, (buckets.get(key) ?? 0) + transaction.magnitudeCents);
    }
    return [...buckets.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, amountCents]) => ({ monthKey: key, amountCents }));
  }, [vendorTransactions]);

  const accountsUsed = useMemo(
    () => [...new Set(vendorTransactions.map((transaction) => transaction.accountName).filter(Boolean))],
    [vendorTransactions],
  );

  const withReceipt = vendorTransactions.filter((transaction) => transaction.hasReceipt).length;
  const receiptPercent =
    vendorTransactions.length === 0 ? null : (withReceipt / vendorTransactions.length) * 100;

  return (
    <Drawer
      title={vendor.name}
      eyebrow="Vendor"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="fb-primary-btn"
            onClick={() => onDrilldown({ kind: "transactions", filters: { vendorQuery: vendor.name } })}
          >
            Open these transactions
          </button>
          {vendor.unreconciledCount > 0 ? (
            <button
              type="button"
              className="fb-secondary-btn"
              onClick={() => onDrilldown({ kind: "reconciliation", queue: "unreconciled" })}
            >
              Reconcile {vendor.unreconciledCount} item{vendor.unreconciledCount === 1 ? "" : "s"}
            </button>
          ) : null}
        </>
      }
    >
      <div className="fb-metric-grid fb-an-grid--compact">
        <MetricCard label="Total spend" value={formatMoney(vendor.totalSpendCents)} tone="out" />
        <MetricCard label="Transactions" value={vendor.transactionCount} />
        <MetricCard label="Average purchase" value={formatMoney(vendor.averageCents)} />
        <MetricCard label="Largest purchase" value={formatMoney(vendor.largestCents)} />
        <MetricCard
          label="Share of spending"
          value={formatPercent(vendor.percentOfSpend, 1)}
          hint="Of all department spending in this period"
        />
        <MetricCard
          label={comparisonLabel ? `Versus ${comparisonLabel}` : "Change"}
          value={describeChange(vendor.change)}
          hint={vendor.change.hasComparison ? undefined : "No comparison period selected"}
        />
        <MetricCard
          label="Receipts on file"
          value={receiptPercent == null ? "—" : formatPercent(receiptPercent, 0)}
          tone={vendor.missingReceiptCount > 0 ? "warn" : undefined}
          hint={vendor.missingReceiptCount > 0 ? `${vendor.missingReceiptCount} missing` : "Every purchase has one"}
        />
        <MetricCard
          label="Activity"
          value={formatIsoDate(vendor.lastActivity)}
          hint={`First seen ${formatIsoDate(vendor.firstActivity)}`}
        />
      </div>

      <SpendTrendChart
        title="Spending over time"
        points={trend}
        emptyMessage="No dated purchases from this vendor in the selected period."
        seriesName={`Paid to ${vendor.name}`}
      />

      <h4 className="fb-an-subheading">Categories</h4>
      {vendor.topCategories.length === 0 ? (
        <p className="muted">Nothing from this vendor has been categorized yet.</p>
      ) : (
        <ul className="fb-an-inline-facts">
          {vendor.topCategories.map((entry) => (
            <li key={entry.category}>
              <span>{entry.category}</span>
              <strong>{formatMoney(entry.amountCents)}</strong>
            </li>
          ))}
        </ul>
      )}

      <h4 className="fb-an-subheading">Accounts and cards used</h4>
      <p className="muted">{accountsUsed.length > 0 ? accountsUsed.join(", ") : "Not recorded"}</p>

      <h4 className="fb-an-subheading">Transaction history</h4>
      <div className="table-wrap">
        <table>
          <caption className="fb-an-visually-hidden">
            Purchases from {vendor.name} in the selected period
          </caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Category</th>
              <th scope="col">Account</th>
              <th scope="col">Amount</th>
              <th scope="col">Receipt</th>
            </tr>
          </thead>
          <tbody>
            {vendorTransactions.map((transaction) => (
              <tr key={transaction.id}>
                <th scope="row">{transaction.date ?? "—"}</th>
                <td>{transaction.category || "Not categorized"}</td>
                <td>{transaction.accountName || "—"}</td>
                <td>{formatMoney(transaction.magnitudeCents)}</td>
                <td>{transaction.hasReceipt ? "On file" : "Missing"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Drawer>
  );
}
