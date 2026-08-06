"use client";

/**
 * The global analytics controls: date range, comparison, account and category
 * filters. Everything the dashboard shows below is scoped by these.
 *
 * The selections live in the URL query string so a view can be bookmarked or
 * pasted to another officer and open the same way.
 */

import { useMemo, useState } from "react";

import {
  COMPARISON_MODES,
  DATE_RANGE_PRESETS,
  formatRangeLabel,
  isValidRange,
} from "../../lib/analytics/date-range";
import { FUND_LABELS } from "../../lib/analytics/accounts";
import { formatIsoDate } from "../../lib/analytics/format";
import type { AnalyticsFilters } from "../../lib/analytics/engine";
import type {
  AnalyticsPeriod,
  ClassifiedAccount,
  ComparisonModeId,
  DateRange,
  DateRangePresetId,
} from "../../lib/analytics/types";
import { Drawer } from "./primitives";

export type ControlsState = {
  preset: DateRangePresetId;
  customRange: DateRange | null;
  comparison: ComparisonModeId;
  filters: AnalyticsFilters;
};

export function AnalyticsControls({
  state,
  period,
  asOf,
  accounts,
  categories,
  isRefreshing,
  onChange,
  onRefresh,
}: {
  state: ControlsState;
  period: AnalyticsPeriod;
  /** The date every figure below is current to. */
  asOf: string;
  accounts: ClassifiedAccount[];
  categories: string[];
  isRefreshing: boolean;
  onChange: (next: ControlsState) => void;
  onRefresh: () => void;
}) {
  const [customStart, setCustomStart] = useState(state.customRange?.start ?? period.range.start);
  const [customEnd, setCustomEnd] = useState(state.customRange?.end ?? period.range.end);
  const [customError, setCustomError] = useState<string | null>(null);

  const [showFilters, setShowFilters] = useState(false);

  const accountGroups = useMemo(() => groupAccounts(accounts), [accounts]);
  const selectedAccountCount = state.filters.accountIds.length;
  const selectedCategoryCount = state.filters.categories.length;
  const activeFilterCount =
    selectedAccountCount +
    selectedCategoryCount +
    (state.comparison !== "none" ? 1 : 0);

  function applyCustomRange() {
    const range = { start: customStart, end: customEnd };
    if (!isValidRange(range)) {
      setCustomError("Enter a start date on or before the end date.");
      return;
    }
    setCustomError(null);
    onChange({ ...state, preset: "custom", customRange: range });
  }

  function toggleAccount(accountId: string) {
    const next = state.filters.accountIds.includes(accountId)
      ? state.filters.accountIds.filter((id) => id !== accountId)
      : [...state.filters.accountIds, accountId];
    onChange({ ...state, filters: { ...state.filters, accountIds: next } });
  }

  function toggleCategory(category: string) {
    const next = state.filters.categories.includes(category)
      ? state.filters.categories.filter((entry) => entry !== category)
      : [...state.filters.categories, category];
    onChange({ ...state, filters: { ...state.filters, categories: next } });
  }

  return (
    <section className="card fb-an-controls" aria-label="Analytics filters">
      <div className="fb-an-controls-compact">
        <fieldset className="fb-an-control">
          <legend className="fb-an-control-label">Date range</legend>
          <div className="fb-chip-row" role="group">
            {DATE_RANGE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={`fb-chip ${state.preset === preset.id ? "fb-chip-active" : ""}`}
                aria-pressed={state.preset === preset.id}
                onClick={() =>
                  onChange({
                    ...state,
                    preset: preset.id,
                    customRange: preset.id === "custom" ? state.customRange : null,
                  })
                }
              >
                {preset.label}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="fb-an-controls-summary">
          <p className="fb-an-asof">
            <span className="fb-an-asof-label">Showing</span>
            <strong>{formatRangeLabel(period.range)}</strong>
            <span className="muted">as of {formatIsoDate(asOf)}</span>
          </p>
          {period.comparison ? (
            <p className="muted fb-an-compare-note">
              Compared with {formatRangeLabel(period.comparison)}
            </p>
          ) : null}
          <button type="button" className="fb-secondary-btn" onClick={() => setShowFilters(true)}>
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
          </button>
          <button
            type="button"
            className="fb-secondary-btn"
            onClick={onRefresh}
            disabled={isRefreshing}
          >
            {isRefreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {state.preset === "custom" ? (
        <div className="fb-an-custom-range">
          <label className="fb-an-control-label" htmlFor="fb-an-custom-start">
            From
            <input
              id="fb-an-custom-start"
              type="date"
              value={customStart}
              max={customEnd}
              onChange={(event) => setCustomStart(event.target.value)}
            />
          </label>
          <label className="fb-an-control-label" htmlFor="fb-an-custom-end">
            To
            <input
              id="fb-an-custom-end"
              type="date"
              value={customEnd}
              min={customStart}
              onChange={(event) => setCustomEnd(event.target.value)}
            />
          </label>
          <button type="button" className="fb-secondary-btn" onClick={applyCustomRange}>
            Apply range
          </button>
          {customError ? (
            <p className="notice notice-error" role="alert">
              {customError}
            </p>
          ) : null}
        </div>
      ) : null}

      {showFilters ? (
        <Drawer title="Filters" eyebrow="Analytics" onClose={() => setShowFilters(false)}>
          <fieldset className="fb-an-control">
            <legend className="fb-an-control-label">Compare with</legend>
            <div className="fb-chip-row" role="group">
              {COMPARISON_MODES.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  className={`fb-chip ${state.comparison === mode.id ? "fb-chip-active" : ""}`}
                  aria-pressed={state.comparison === mode.id}
                  onClick={() => onChange({ ...state, comparison: mode.id })}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </fieldset>

          <FilterGroup
            label="Accounts"
            disabled={accounts.length === 0}
            onClear={
              selectedAccountCount > 0
                ? () => onChange({ ...state, filters: { ...state.filters, accountIds: [] } })
                : undefined
            }
          >
            {accountGroups.map((group) => (
              <div key={group.label} className="fb-an-filter-group">
                <p className="fb-an-filter-group-label">{group.label}</p>
                {group.accounts.map((account) => (
                  <label key={account.id} className="fb-settings-checkbox fb-an-filter-option">
                    <input
                      type="checkbox"
                      checked={state.filters.accountIds.includes(account.id)}
                      onChange={() => toggleAccount(account.id)}
                    />
                    <span>{account.name}</span>
                  </label>
                ))}
              </div>
            ))}
          </FilterGroup>

          <FilterGroup
            label="Categories"
            disabled={categories.length === 0}
            onClear={
              selectedCategoryCount > 0
                ? () => onChange({ ...state, filters: { ...state.filters, categories: [] } })
                : undefined
            }
          >
            <div className="fb-an-filter-group fb-an-filter-group--scroll">
              {categories.map((category) => (
                <label key={category} className="fb-settings-checkbox fb-an-filter-option">
                  <input
                    type="checkbox"
                    checked={state.filters.categories.includes(category)}
                    onChange={() => toggleCategory(category)}
                  />
                  <span>{category}</span>
                </label>
              ))}
            </div>
          </FilterGroup>
        </Drawer>
      ) : null}
    </section>
  );
}

function FilterGroup({
  label,
  disabled,
  onClear,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClear?: () => void;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <div className="fb-an-control">
        <p className="fb-an-control-label">{label}</p>
        <p className="muted">Nothing to filter yet</p>
      </div>
    );
  }

  return (
    <div className="fb-an-control fb-an-filter">
      <p className="fb-an-control-label">{label}</p>
      <div className="fb-an-filter-panel">
        {onClear ? (
          <button type="button" className="link-button" onClick={onClear}>
            Clear {label.toLowerCase()}
          </button>
        ) : null}
        {children}
      </div>
    </div>
  );
}

/**
 * Accounts are grouped by fund designation when the department has recorded
 * one, because "which fund" is the question officers actually ask.
 */
function groupAccounts(accounts: ClassifiedAccount[]) {
  const groups = new Map<string, ClassifiedAccount[]>();
  for (const account of accounts) {
    const label = account.isTwoPercent
      ? FUND_LABELS.two_percent
      : (FUND_LABELS[account.fund] ?? "Other accounts");
    const bucket = groups.get(label) ?? [];
    bucket.push(account);
    groups.set(label, bucket);
  }
  return [...groups.entries()].map(([label, group]) => ({ label, accounts: group }));
}
