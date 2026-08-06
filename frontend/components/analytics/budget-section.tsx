"use client";

/**
 * Budget status.
 *
 * Budget status is judged against how far through the year the department
 * is, so a category spending steadily is called "on track" rather than being
 * coloured red for reaching 50% in June.
 *
 * This lives in the secondary "More analytics" area rather than the primary
 * grid — cash flow already answers "is money coming in and going out
 * normally", and a department that hasn't set up budgets yet should see a
 * narrow setup callout, not an empty report-sized card.
 */

import { useState } from "react";

import {
  BUDGET_STATUS_LABELS,
  BUDGET_STATUS_LEVEL,
  type BudgetLine,
} from "../../lib/analytics/budgets";
import { formatMoney, formatPercent, formatSignedMoney } from "../../lib/analytics/format";
import type { AnalyticsResult } from "../../lib/analytics/engine";
import type { DrilldownTarget } from "../../lib/analytics/types";
import { Drawer, ProgressMeter, StatusPill } from "./primitives";

export function BudgetSection({
  result,
  canManage,
  isSaving,
  onSaveBudget,
  onDeleteBudget,
  onDrilldown,
}: {
  result: AnalyticsResult;
  canManage: boolean;
  isSaving: boolean;
  onSaveBudget: (category: string, amount: string) => void;
  onDeleteBudget: (category: string) => void;
  onDrilldown: (target: DrilldownTarget) => void;
}) {
  const { budgets } = result;
  const [showDetail, setShowDetail] = useState(false);

  if (!budgets.hasBudgets) {
    return (
      <div className="fb-an-budget-status-callout">
        <span>No {budgets.fiscalYear} budgets are set up.</span>
        {canManage ? (
          <button type="button" className="fb-secondary-btn" onClick={() => setShowDetail(true)}>
            Set up budgets
          </button>
        ) : null}
        {showDetail ? (
          <Drawer title="Budgets" eyebrow="Planning" onClose={() => setShowDetail(false)}>
            <BudgetEditor
              lines={budgets.lines}
              categories={result.categories.map((category) => category.category)}
              fiscalYear={budgets.fiscalYear}
              isSaving={isSaving}
              onSave={onSaveBudget}
              onDelete={onDeleteBudget}
            />
          </Drawer>
        ) : null}
      </div>
    );
  }

  return (
    <div className="fb-an-budget-status-row">
      <div className="fb-an-budget-status-line">
        <StatusPill
          level={budgets.overBudgetCount > 0 ? "attention" : "positive"}
          label={
            budgets.overBudgetCount > 0
              ? `${budgets.overBudgetCount} over budget`
              : "On track"
          }
          size="small"
        />
        <span className="muted">
          {formatMoney(budgets.totalActualCents)} spent of {formatMoney(budgets.totalBudgetCents)}{" "}
          planned for {budgets.fiscalYear}
        </span>
      </div>
      <button type="button" className="fb-secondary-btn" onClick={() => setShowDetail(true)}>
        View budgets
      </button>

      {showDetail ? (
        <Drawer title="Budgets and cash flow" eyebrow="Planning" onClose={() => setShowDetail(false)}>
          <div className="fb-metric-grid">
            <MetricCardLite label="Planned" value={formatMoney(budgets.totalBudgetCents)} />
            <MetricCardLite
              label="Spent so far"
              value={formatMoney(budgets.totalActualCents)}
              tone="out"
              hint={`${budgets.monthsElapsed} of 12 months elapsed`}
            />
            <MetricCardLite
              label="Remaining"
              value={formatSignedMoney(budgets.totalRemainingCents)}
              tone={budgets.totalRemainingCents < 0 ? "out" : undefined}
            />
            <MetricCardLite
              label="Over budget"
              value={String(budgets.overBudgetCount)}
              tone={budgets.overBudgetCount > 0 ? "warn" : undefined}
              hint={
                budgets.approachingCount > 0
                  ? `${budgets.approachingCount} more approaching`
                  : "Categories past their planned amount"
              }
            />
            {budgets.unbudgetedCategoryCount > 0 ? (
              <MetricCardLite
                label="Spending with no budget"
                value={formatMoney(budgets.unbudgetedActualCents)}
                hint={`Across ${budgets.unbudgetedCategoryCount} categor${budgets.unbudgetedCategoryCount === 1 ? "y" : "ies"}`}
              />
            ) : null}
          </div>

          <ul className="fb-an-budget-list">
            {budgets.lines.map((line) => (
              <BudgetRow key={line.category} line={line} onDrilldown={onDrilldown} />
            ))}
          </ul>

          {canManage ? (
            <BudgetEditor
              lines={budgets.lines}
              categories={result.categories.map((category) => category.category)}
              fiscalYear={budgets.fiscalYear}
              isSaving={isSaving}
              onSave={onSaveBudget}
              onDelete={onDeleteBudget}
            />
          ) : null}
        </Drawer>
      ) : null}
    </div>
  );
}

function MetricCardLite({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: "out" | "warn";
  hint?: string;
}) {
  const toneClass = tone === "out" ? "fb-metric-value--out" : tone === "warn" ? "fb-metric-value--warn" : "";
  return (
    <div className="fb-metric-card">
      <p className="fb-metric-label">{label}</p>
      <p className={`fb-metric-value ${toneClass}`}>{value}</p>
      {hint ? <p className="fb-metric-hint">{hint}</p> : null}
    </div>
  );
}

function BudgetRow({
  line,
  onDrilldown,
}: {
  line: BudgetLine;
  onDrilldown: (target: DrilldownTarget) => void;
}) {
  const level = BUDGET_STATUS_LEVEL[line.status];

  return (
    <li className="fb-an-budget-row">
      <div className="fb-an-budget-head">
        <button
          type="button"
          className="link-button"
          onClick={() => onDrilldown({ kind: "transactions", filters: { category: line.category } })}
        >
          {line.category}
        </button>
        <StatusPill level={level} label={BUDGET_STATUS_LABELS[line.status]} size="small" />
      </div>
      <ProgressMeter
        percent={line.percentConsumed}
        level={level}
        label={`${line.category}: ${formatPercent(line.percentConsumed, 0)} of budget used`}
      />
      <p className="fb-an-budget-figures">
        <span>
          <strong>{formatMoney(line.actualCents)}</strong> of {formatMoney(line.budgetCents)} spent
        </span>
        <span className="muted">
          {line.remainingCents >= 0
            ? `${formatMoney(line.remainingCents)} remaining`
            : `${formatMoney(Math.abs(line.remainingCents))} over`}
        </span>
        {line.projectedYearEndCents != null ? (
          <span className="muted">
            Projected {formatMoney(line.projectedYearEndCents)} by year end
          </span>
        ) : null}
        {line.priorYearActualCents != null ? (
          <span className="muted">Last year {formatMoney(line.priorYearActualCents)}</span>
        ) : null}
      </p>
    </li>
  );
}

function BudgetEditor({
  lines,
  categories,
  fiscalYear,
  isSaving,
  onSave,
  onDelete,
}: {
  lines: BudgetLine[];
  categories: string[];
  fiscalYear: number;
  isSaving: boolean;
  onSave: (category: string, amount: string) => void;
  onDelete: (category: string) => void;
}) {
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);

  const suggestions = categories.filter(
    (option) => !lines.some((line) => line.category.toLowerCase() === option.toLowerCase()),
  );

  function submit() {
    const trimmed = category.trim();
    if (!trimmed) {
      setError("Choose or type a category.");
      return;
    }
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setError("Enter a planned amount of zero or more.");
      return;
    }
    setError(null);
    onSave(trimmed, amount);
    setCategory("");
    setAmount("");
  }

  return (
    <div className="fb-an-budget-editor">
      <h4 className="fb-an-subheading">Planned amounts for {fiscalYear}</h4>
      <p className="muted">
        Enter what the department plans to spend in a category this year. Saving a category that is
        already listed replaces its amount.
      </p>

      <div className="fb-an-budget-form">
        <label className="fb-an-control-label" htmlFor="fb-an-budget-category">
          Category
          <input
            id="fb-an-budget-category"
            list="fb-an-budget-categories"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            placeholder="Fuel"
          />
        </label>
        <datalist id="fb-an-budget-categories">
          {suggestions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>

        <label className="fb-an-control-label" htmlFor="fb-an-budget-amount">
          Planned amount
          <input
            id="fb-an-budget-amount"
            type="number"
            min={0}
            step="0.01"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="5000.00"
          />
        </label>

        <button type="button" className="fb-primary-btn" disabled={isSaving} onClick={submit}>
          {isSaving ? "Saving…" : "Save budget"}
        </button>
      </div>

      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}

      {lines.length > 0 ? (
        <ul className="fb-an-budget-chips">
          {lines.map((line) => (
            <li key={line.category}>
              <span>
                {line.category} — {formatMoney(line.budgetCents)}
              </span>
              <button
                type="button"
                className="link-button"
                disabled={isSaving}
                onClick={() => onDelete(line.category)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
