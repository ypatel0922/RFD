import { describe, expect, it } from "vitest";

import {
  PRIMARY_NAV_ITEMS,
  analyticsSectionAnchor,
  resolveAnalyticsSection,
  resolveViewFromTab,
} from "./navigation";

describe("primary navigation", () => {
  it("includes Analytics", () => {
    const analytics = PRIMARY_NAV_ITEMS.find((item) => item.id === "analytics");
    expect(analytics).toBeDefined();
    expect(analytics?.label).toBe("Analytics");
    expect(analytics?.iconPaths.length).toBeGreaterThan(0);
  });

  it("no longer includes Vendors", () => {
    expect(PRIMARY_NAV_ITEMS.some((item) => item.label.toLowerCase().includes("vendor"))).toBe(false);
    expect(PRIMARY_NAV_ITEMS.map((item) => String(item.id))).not.toContain("vendors");
  });

  it("places Analytics where Vendors used to sit, after Tax Forms", () => {
    const ids = PRIMARY_NAV_ITEMS.map((item) => item.id);
    expect(ids.indexOf("analytics")).toBe(ids.indexOf("tax_forms") + 1);
  });

  it("keeps every other tab intact", () => {
    expect(PRIMARY_NAV_ITEMS.map((item) => item.id)).toEqual([
      "dashboard",
      "transactions",
      "reconciliation",
      "accounts",
      "reports_documents",
      "tax_forms",
      "analytics",
    ]);
  });

  it("gives every item a label and an icon", () => {
    for (const item of PRIMARY_NAV_ITEMS) {
      expect(item.label.trim().length).toBeGreaterThan(0);
      expect(item.iconPaths.length).toBeGreaterThan(0);
    }
  });
});

describe("legacy vendor links", () => {
  it("sends the old vendors tab to vendor analytics rather than nowhere", () => {
    expect(resolveViewFromTab("vendors")).toEqual({
      view: "analytics",
      analyticsSection: "vendors",
    });
  });

  it("accepts the singular form too", () => {
    expect(resolveViewFromTab("vendor")?.view).toBe("analytics");
  });

  it("ignores casing and surrounding space", () => {
    expect(resolveViewFromTab("  Vendors ")?.analyticsSection).toBe("vendors");
  });
});

describe("tab resolution", () => {
  it("resolves each primary tab", () => {
    for (const item of PRIMARY_NAV_ITEMS) {
      expect(resolveViewFromTab(item.id)?.view).toBe(item.id);
    }
  });

  it("resolves settings, which lives outside the primary list", () => {
    expect(resolveViewFromTab("settings")?.view).toBe("settings");
  });

  it("returns nothing for an unknown tab so the app keeps its default view", () => {
    expect(resolveViewFromTab("does-not-exist")).toBeNull();
    expect(resolveViewFromTab("")).toBeNull();
    expect(resolveViewFromTab(null)).toBeNull();
  });

  it("reads an analytics section from the query string", () => {
    expect(resolveViewFromTab("analytics", "two_percent")).toEqual({
      view: "analytics",
      analyticsSection: "two_percent",
    });
  });

  it("ignores an unknown analytics section", () => {
    expect(resolveViewFromTab("analytics", "nonsense")?.analyticsSection).toBeNull();
    expect(resolveAnalyticsSection("nonsense")).toBeNull();
  });
});

describe("section anchors", () => {
  it("builds a stable DOM id for deep links", () => {
    expect(analyticsSectionAnchor("two_percent")).toBe("analytics-two-percent");
    expect(analyticsSectionAnchor("vendors")).toBe("analytics-vendors");
  });
});
