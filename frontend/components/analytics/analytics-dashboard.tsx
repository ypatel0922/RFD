"use client";

/**
 * The Analytics tab.
 *
 * Data is fetched once per department and date window, then every section is
 * derived from that single in-memory result by the pure engine in
 * lib/analytics. Changing a filter re-derives without another round trip;
 * only moving the date window outside what was fetched causes a new read.
 *
 * Every query is scoped to the caller's current department and RLS enforces
 * that on the server, so nothing here can reach another department's records.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DEFAULT_COMPARISON,
  DEFAULT_PRESET,
  buildPeriod,
  earliestNeededDate,
  isValidRange,
  todayIso,
} from "../../lib/analytics/date-range";
import {
  DEFAULT_ANALYTICS_SETTINGS,
  EMPTY_FILTERS,
  EMPTY_SOURCE_DATA,
  runAnalytics,
  type AnalyticsFilters,
  type AnalyticsSourceData,
} from "../../lib/analytics/engine";
import {
  deleteBudget,
  fetchAnalyticsData,
  fetchAnalyticsSettings,
  friendlyDataError,
  saveAccountClassification,
  saveAnalyticsSettings,
  saveBudget,
  saveTwoPercentDesignation,
} from "../../lib/analytics/data";
import { normalizeCategoryKey } from "../../lib/analytics/budgets";
import { analyticsSectionAnchor, type AnalyticsSectionId } from "../../lib/navigation";
import type {
  ClassifiedAccount,
  DepartmentAnalyticsSettings,
  DrilldownTarget,
  TwoPercentBasis,
} from "../../lib/analytics/types";
import { AnalyticsControls, type ControlsState } from "./controls";
import { HealthSection } from "./health-section";
import { InsightsSection } from "./insights-section";
import { ErrorState, MetricSkeletonGrid, SectionSkeleton } from "./primitives";
import { TwoPercentSection } from "./two-percent-section";

// Lower-priority sections load after the health and insights are on screen, so
// the first thing a treasurer sees is not waiting on the vendor table or the
// chart bundle.
const AccountsSection = lazy(() =>
  import("./accounts-section").then((module) => ({ default: module.AccountsSection })),
);
const SpendingSection = lazy(() =>
  import("./spending-section").then((module) => ({ default: module.SpendingSection })),
);
const VendorsSection = lazy(() =>
  import("./vendors-section").then((module) => ({ default: module.VendorsSection })),
);
const BudgetSection = lazy(() =>
  import("./budget-section").then((module) => ({ default: module.BudgetSection })),
);
const ReadinessSection = lazy(() =>
  import("./readiness-section").then((module) => ({ default: module.ReadinessSection })),
);
const CashFlowChartCard = lazy(() =>
  import("./cash-flow-section").then((module) => ({ default: module.CashFlowChartCard })),
);

type LoadState = "idle" | "loading" | "ready" | "error";

export function AnalyticsDashboard({
  departmentId,
  departmentName,
  userId,
  canManage,
  initialSection,
  onDrilldown,
}: {
  departmentId: string;
  departmentName: string;
  /** Recorded against configuration this member changes. */
  userId: string | null;
  /** Whether this member may change department-wide analytics configuration. */
  canManage: boolean;
  initialSection: AnalyticsSectionId | null;
  /**
   * Opens records outside Analytics. The host app owns the Transactions,
   * Reconciliation and Settings views, so it performs the navigation.
   */
  onDrilldown: (target: DrilldownTarget) => void;
}) {
  const today = useMemo(() => todayIso(), []);

  const [controls, setControls] = useState<ControlsState>(readControlsFromUrl);
  const [data, setData] = useState<AnalyticsSourceData>(EMPTY_SOURCE_DATA);
  const [settings, setSettings] = useState<DepartmentAnalyticsSettings>({
    department_id: departmentId,
    ...DEFAULT_ANALYTICS_SETTINGS,
  });
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [savingAccountId, setSavingAccountId] = useState<string | null>(null);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isSavingBudget, setIsSavingBudget] = useState(false);
  const [selectedVendorKey, setSelectedVendorKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const period = useMemo(
    () =>
      buildPeriod({
        preset: controls.preset,
        custom: controls.customRange,
        comparisonMode: controls.comparison,
        today,
      }),
    [controls.preset, controls.customRange, controls.comparison, today],
  );

  // The fetch window covers the comparison period and the prior year end, so a
  // carryover balance and a year-over-year comparison are both answerable from
  // one read.
  const fetchFrom = useMemo(() => earliestNeededDate(period), [period]);
  const fetchTo = period.range.end;

  // ── Load ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!departmentId) return;
    let cancelled = false;

    setLoadState((current) => (current === "ready" ? "ready" : "loading"));
    setErrorMessage(null);

    void (async () => {
      try {
        const [sourceData, loadedSettings] = await Promise.all([
          fetchAnalyticsData({ departmentId, from: fetchFrom, to: fetchTo }),
          fetchAnalyticsSettings(departmentId),
        ]);
        if (cancelled) return;
        setData(sourceData);
        if (loadedSettings) setSettings(loadedSettings);
        setLoadState("ready");
      } catch (error) {
        if (cancelled) return;
        setErrorMessage(friendlyDataError(error));
        setLoadState("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [departmentId, fetchFrom, fetchTo, reloadToken]);

  // Data belongs to one department. Switching departments must never show the
  // previous one's figures while the next load is in flight.
  useEffect(() => {
    setData(EMPTY_SOURCE_DATA);
    setLoadState("loading");
    setSelectedVendorKey(null);
  }, [departmentId]);

  // ── Derive ─────────────────────────────────────────────────────────────────
  const result = useMemo(
    () => runAnalytics({ data, period, settings, filters: controls.filters, today }),
    [data, period, settings, controls.filters, today],
  );

  useSyncUrl(controls, initialSection);
  useScrollToSection(initialSection, loadState);

  const categoryOptions = useMemo(() => {
    const names = new Set<string>();
    for (const expense of data.expenses) {
      const category = expense.category?.trim();
      if (category) names.add(category);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [data.expenses]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const persistSettings = useCallback(
    async (patch: Partial<Pick<DepartmentAnalyticsSettings, "two_percent_target_percent" | "two_percent_basis">>) => {
      const next = { ...settings, ...patch };
      setSettings(next);
      if (!canManage) return;

      setIsSavingSettings(true);
      setActionError(null);
      try {
        await saveAnalyticsSettings({
          departmentId,
          targetPercent: next.two_percent_target_percent,
          basis: next.two_percent_basis,
          userId,
        });
      } catch (error) {
        setActionError(friendlyDataError(error));
      } finally {
        setIsSavingSettings(false);
      }
    },
    [canManage, departmentId, settings, userId],
  );

  const designateTwoPercentAccount = useCallback(
    async (accountId: string) => {
      setSavingAccountId(accountId);
      setActionError(null);
      try {
        await saveTwoPercentDesignation({ accountId, isTwoPercentAccount: true });
        refresh();
      } catch (error) {
        setActionError(friendlyDataError(error));
      } finally {
        setSavingAccountId(null);
      }
    },
    [refresh],
  );

  const classifyAccount = useCallback(
    async (account: ClassifiedAccount, accountType: string, fundType: string) => {
      setSavingAccountId(account.id);
      setActionError(null);
      try {
        await saveAccountClassification({
          accountId: account.id,
          accountType,
          fundType: fundType || null,
          isTwoPercentAccount: fundType === "two_percent",
        });
        refresh();
      } catch (error) {
        setActionError(friendlyDataError(error));
      } finally {
        setSavingAccountId(null);
      }
    },
    [refresh],
  );

  const upsertBudget = useCallback(
    async (category: string, amount: string) => {
      setIsSavingBudget(true);
      setActionError(null);
      try {
        await saveBudget({
          departmentId,
          fiscalYear: result.budgets.fiscalYear,
          category,
          amountDollars: Number(amount),
          userId,
        });
        refresh();
      } catch (error) {
        setActionError(friendlyDataError(error));
      } finally {
        setIsSavingBudget(false);
      }
    },
    [departmentId, refresh, result.budgets.fiscalYear, userId],
  );

  const removeBudget = useCallback(
    async (category: string) => {
      const key = normalizeCategoryKey(category);
      const row = data.budgets.find(
        (budget) =>
          budget.fiscal_year === result.budgets.fiscalYear &&
          (budget.normalized_category || normalizeCategoryKey(budget.category)) === key,
      );
      if (!row) return;

      setIsSavingBudget(true);
      setActionError(null);
      try {
        await deleteBudget(row.id);
        refresh();
      } catch (error) {
        setActionError(friendlyDataError(error));
      } finally {
        setIsSavingBudget(false);
      }
    },
    [data.budgets, refresh, result.budgets.fiscalYear],
  );

  const handleDrilldown = useCallback(
    (target: DrilldownTarget) => {
      // A vendor stays on this page; everything else lives in another view.
      if (target.kind === "vendor") {
        setSelectedVendorKey(target.vendorKey);
        document
          .getElementById(analyticsSectionAnchor("vendors"))
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      onDrilldown(target);
    },
    [onDrilldown],
  );

  // ── Render ─────────────────────────────────────────────────────────────────
  const isInitialLoad = loadState === "loading" && data === EMPTY_SOURCE_DATA;

  return (
    <div className="fb-tab-stack fb-an-page">
      <AnalyticsControls
        state={controls}
        period={period}
        asOf={result.asOf}
        accounts={result.accounts}
        categories={categoryOptions}
        departmentName={departmentName}
        isRefreshing={loadState === "loading"}
        onChange={setControls}
        onRefresh={refresh}
      />

      {actionError ? <ErrorState message={actionError} /> : null}

      {loadState === "error" ? (
        <section className="card">
          <ErrorState
            message={errorMessage ?? "Analytics could not load right now."}
            onRetry={refresh}
          />
        </section>
      ) : isInitialLoad ? (
        <>
          <section className="card">
            <SectionSkeleton label="Loading department health" rows={3} />
            <MetricSkeletonGrid count={8} />
          </section>
          <section className="card">
            <SectionSkeleton label="Loading insights" rows={2} />
          </section>
        </>
      ) : (
        <>
          <div className="fb-an-kpi-row">
            <HealthSection
              result={result}
              sectionId={analyticsSectionAnchor("overview")}
              onDrilldown={handleDrilldown}
            />

            <TwoPercentSection
              result={result}
              sectionId={analyticsSectionAnchor("two_percent")}
              canManage={canManage}
              accounts={result.accounts}
              basis={settings.two_percent_basis}
              targetPercent={settings.two_percent_target_percent}
              isSavingSettings={isSavingSettings || savingAccountId != null}
              onBasisChange={(basis: TwoPercentBasis) =>
                void persistSettings({ two_percent_basis: basis })
              }
              onTargetChange={(percent) =>
                void persistSettings({ two_percent_target_percent: percent })
              }
              onDesignateAccount={(accountId) => void designateTwoPercentAccount(accountId)}
              onDrilldown={handleDrilldown}
            />

            <Suspense fallback={<DeferredSection label="Loading accounts" />}>
              <AccountsSection
                result={result}
                sectionId={analyticsSectionAnchor("accounts")}
                canManage={canManage}
                savingAccountId={savingAccountId}
                onClassifyAccount={(account, accountType, fundType) =>
                  void classifyAccount(account, accountType, fundType)
                }
                onDrilldown={handleDrilldown}
              />
            </Suspense>
          </div>

          <div className="fb-an-grid-primary">
            <div className="fb-an-stack fb-an-insights-column">
              <InsightsSection
                insights={result.insights}
                sectionId={analyticsSectionAnchor("insights")}
                hasData={!result.isEmpty}
                onDrilldown={handleDrilldown}
              />

              <Suspense fallback={<DeferredSection label="Loading readiness" />}>
                <ReadinessSection
                  result={result}
                  sectionId={analyticsSectionAnchor("readiness")}
                  onDrilldown={handleDrilldown}
                />
              </Suspense>
            </div>

            <Suspense fallback={<DeferredSection label="Loading spending" />}>
              <SpendingSection
                result={result}
                sectionId={analyticsSectionAnchor("spending")}
                onDrilldown={handleDrilldown}
              />
            </Suspense>
          </div>

          <div className="fb-an-grid-halves fb-an-row-bottom">
            <Suspense fallback={<DeferredSection label="Loading vendors" />}>
              <VendorsSection
                result={result}
                sectionId={analyticsSectionAnchor("vendors")}
                selectedVendorKey={selectedVendorKey}
                onSelectVendor={setSelectedVendorKey}
                onDrilldown={handleDrilldown}
              />
            </Suspense>

            <Suspense fallback={<DeferredSection label="Loading cash flow" />}>
              <CashFlowChartCard result={result} sectionId={analyticsSectionAnchor("cash_flow")} />
            </Suspense>
          </div>

          <details
            id={analyticsSectionAnchor("budgets")}
            className="card fb-an-section fb-an-section--compact fb-an-more-panel"
          >
            <summary className="fb-an-more-summary">
              <span>
                <span className="eyebrow">Planning</span>
                <strong>Budget status & more</strong>
              </span>
              <span className="muted">Optional detail</span>
            </summary>
            <Suspense fallback={<SectionSkeleton label="Loading budgets" rows={2} />}>
              <BudgetSection
                result={result}
                canManage={canManage}
                isSaving={isSavingBudget}
                onSaveBudget={(category, amount) => void upsertBudget(category, amount)}
                onDeleteBudget={(category) => void removeBudget(category)}
                onDrilldown={handleDrilldown}
              />
            </Suspense>
            <nav className="fb-an-more" aria-label="Jump to more analytics">
              <MoreLink label="Records" targetSection="readiness" />
              <MoreLink label="Accounts" targetSection="accounts" />
              <MoreLink label="Categories" targetSection="spending" />
              <MoreLink label="Vendors" targetSection="vendors" />
              <button
                type="button"
                className="fb-an-more-link"
                onClick={() => handleDrilldown({ kind: "transactions", filters: {} })}
              >
                Transactions
              </button>
            </nav>
          </details>
        </>
      )}
    </div>
  );
}

function MoreLink({
  label,
  targetSection,
}: {
  label: string;
  targetSection: AnalyticsSectionId;
}) {
  return (
    <a
      className="fb-an-more-link"
      href={`#${analyticsSectionAnchor(targetSection)}`}
      onClick={(event) => {
        event.preventDefault();
        document
          .getElementById(analyticsSectionAnchor(targetSection))
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }}
    >
      {label}
    </a>
  );
}

function DeferredSection({ label }: { label: string }) {
  return (
    <section className="card">
      <SectionSkeleton label={label} rows={2} />
    </section>
  );
}

// ─── URL state ────────────────────────────────────────────────────────────────

const URL_KEYS = {
  preset: "range",
  from: "from",
  to: "to",
  comparison: "compare",
  accounts: "accounts",
  categories: "cats",
} as const;

function readControlsFromUrl(): ControlsState {
  const fallback: ControlsState = {
    preset: DEFAULT_PRESET,
    customRange: null,
    comparison: DEFAULT_COMPARISON,
    filters: EMPTY_FILTERS,
  };
  if (typeof window === "undefined") return fallback;

  const params = new URLSearchParams(window.location.search);
  const preset = params.get(URL_KEYS.preset);
  const from = params.get(URL_KEYS.from);
  const to = params.get(URL_KEYS.to);
  const comparison = params.get(URL_KEYS.comparison);

  const customRange = from && to && isValidRange({ start: from, end: to }) ? { start: from, end: to } : null;

  return {
    preset: isPreset(preset) ? preset : customRange ? "custom" : DEFAULT_PRESET,
    customRange,
    comparison: isComparison(comparison) ? comparison : DEFAULT_COMPARISON,
    filters: {
      accountIds: splitParam(params.get(URL_KEYS.accounts)),
      categories: splitParam(params.get(URL_KEYS.categories)),
    },
  };
}

function splitParam(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isPreset(value: string | null): value is ControlsState["preset"] {
  return (
    value === "this_month" ||
    value === "this_quarter" ||
    value === "year_to_date" ||
    value === "last_12_months" ||
    value === "prior_calendar_year" ||
    value === "custom"
  );
}

function isComparison(value: string | null): value is ControlsState["comparison"] {
  return value === "previous_period" || value === "same_period_last_year" || value === "none";
}

/**
 * Mirrors the current selection into the query string so the view can be
 * bookmarked or shared. `replaceState` is used deliberately: filter changes
 * should not fill the browser's back stack.
 */
function useSyncUrl(controls: ControlsState, section: AnalyticsSectionId | null) {
  const isFirstRun = useRef(true);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    params.set("tab", "analytics");
    if (section) params.set("section", section);
    else params.delete("section");

    params.set(URL_KEYS.preset, controls.preset);
    if (controls.preset === "custom" && controls.customRange) {
      params.set(URL_KEYS.from, controls.customRange.start);
      params.set(URL_KEYS.to, controls.customRange.end);
    } else {
      params.delete(URL_KEYS.from);
      params.delete(URL_KEYS.to);
    }

    params.set(URL_KEYS.comparison, controls.comparison);
    setListParam(params, URL_KEYS.accounts, controls.filters.accountIds);
    setListParam(params, URL_KEYS.categories, controls.filters.categories);

    const next = `${window.location.pathname}?${params.toString()}`;
    if (isFirstRun.current) {
      isFirstRun.current = false;
      if (next === `${window.location.pathname}${window.location.search}`) return;
    }
    window.history.replaceState(window.history.state, "", next);
  }, [controls, section]);
}

function setListParam(params: URLSearchParams, key: string, values: string[]) {
  if (values.length === 0) params.delete(key);
  else params.set(key, values.join(","));
}

/**
 * Brings a deep-linked section into view once its content exists. Old
 * `?tab=vendors` bookmarks land on vendor analytics this way.
 */
function useScrollToSection(section: AnalyticsSectionId | null, loadState: LoadState) {
  const hasScrolled = useRef(false);

  useEffect(() => {
    if (!section || hasScrolled.current || loadState !== "ready") return;

    const anchor = analyticsSectionAnchor(section);
    // Lower sections mount through Suspense, so give React a frame to commit
    // them before looking for the element.
    const timer = window.setTimeout(() => {
      const element = document.getElementById(anchor);
      if (!element) return;
      hasScrolled.current = true;
      element.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 250);

    return () => window.clearTimeout(timer);
  }, [section, loadState]);
}
