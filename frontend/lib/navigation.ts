/**
 * Primary navigation for the authenticated app.
 *
 * The sidebar renders from this list so the set of tabs is data rather than
 * markup, and so removing or renaming one is a single change that tests can
 * assert against.
 *
 * Icons are stored as SVG path data and drawn by the sidebar with the same
 * stroke settings the other glyphs use.
 */

/** Every view the app can show, including ones reached only programmatically. */
export type AppView =
  | "dashboard"
  | "transactions"
  | "reconciliation"
  | "reconcile_statement"
  | "accounts"
  | "reports_documents"
  | "tax_forms"
  | "analytics"
  | "settings"
  | "new_expense";

export type NavItem = {
  id: AppView;
  label: string;
  /** One or more `d` attributes drawn inside a 24×24 stroked viewBox. */
  iconPaths: string[];
};

export const PRIMARY_NAV_ITEMS: NavItem[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    iconPaths: ["M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5Z"],
  },
  {
    id: "transactions",
    label: "Transactions",
    iconPaths: ["M4 6h16M4 12h16M4 18h10"],
  },
  {
    id: "reconciliation",
    label: "Reconciliation",
    iconPaths: ["M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"],
  },
  {
    id: "accounts",
    label: "Accounts",
    iconPaths: ["M3 10h18v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V10Z", "M7 10V7a5 5 0 0 1 10 0v3"],
  },
  {
    id: "reports_documents",
    label: "Reports & Documents",
    iconPaths: ["M7 3h8l3 3v15H7V3Z", "M14 3v4h4M9 13h6M9 17h6"],
  },
  {
    id: "tax_forms",
    label: "Tax Forms",
    iconPaths: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z", "M14 2v6h6M8 13h8M8 17h8"],
  },
  {
    id: "analytics",
    label: "Analytics",
    // Activity/pulse line over a baseline, matching the stroked icon set.
    iconPaths: ["M3 12h4l3 8 4-16 3 8h4"],
  },
];

/**
 * Sections within Analytics that can be linked to directly.
 *
 * `vendors` exists so anything that used to point at the Vendors tab lands on
 * vendor analytics rather than the top of the page.
 */
export type AnalyticsSectionId =
  | "overview"
  | "insights"
  | "two_percent"
  | "accounts"
  | "spending"
  | "vendors"
  | "cash_flow"
  | "budgets"
  | "readiness";

export const ANALYTICS_SECTION_IDS: AnalyticsSectionId[] = [
  "overview",
  "insights",
  "two_percent",
  "accounts",
  "spending",
  "vendors",
  "cash_flow",
  "budgets",
  "readiness",
];

export type ResolvedView = {
  view: AppView;
  analyticsSection: AnalyticsSectionId | null;
};

/**
 * Turn a `?tab=` value into a view.
 *
 * Vendors used to be its own tab. Any saved link or shortcut pointing at it now
 * opens the vendor section of Analytics instead of failing, which is why the
 * legacy name is still recognised here even though it is no longer a view.
 */
export function resolveViewFromTab(
  tab: string | null | undefined,
  section?: string | null,
): ResolvedView | null {
  const value = (tab ?? "").trim().toLowerCase();
  if (!value) return null;

  if (value === "vendors" || value === "vendor") {
    return { view: "analytics", analyticsSection: "vendors" };
  }

  if (value === "analytics") {
    return { view: "analytics", analyticsSection: resolveAnalyticsSection(section) };
  }

  const known = PRIMARY_NAV_ITEMS.find((item) => item.id === value);
  if (known) return { view: known.id, analyticsSection: null };

  if (value === "settings") return { view: "settings", analyticsSection: null };

  return null;
}

export function resolveAnalyticsSection(
  section: string | null | undefined,
): AnalyticsSectionId | null {
  const value = (section ?? "").trim().toLowerCase();
  if (!value) return null;
  return ANALYTICS_SECTION_IDS.includes(value as AnalyticsSectionId)
    ? (value as AnalyticsSectionId)
    : null;
}

/** The DOM id an analytics section anchors to, used for deep links. */
export function analyticsSectionAnchor(section: AnalyticsSectionId): string {
  return `analytics-${section.replace(/_/g, "-")}`;
}
