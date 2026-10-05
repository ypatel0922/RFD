import { describe, expect, it } from "vitest";

import {
  computeRibbonPlacement,
  isOutsideRibbon,
  NEW_ENTRY_OPTIONS,
  newEntryTarget,
  ribbonKeyAction,
} from "./new-entry";

const RIBBON = { width: 260, height: 52 };

describe("+ New options", () => {
  it("offers Expense then Money In", () => {
    expect(NEW_ENTRY_OPTIONS.map((option) => option.label)).toEqual(["Expense", "Money In"]);
  });

  it("keeps Expense on the existing receipt-first New Expense flow", () => {
    expect(newEntryTarget("expense")).toEqual({ view: "new_expense", expenseLaunch: { tab: "receipt" } });
  });

  it("opens Money In on document entry", () => {
    expect(newEntryTarget("money_in")).toEqual({ view: "new_money_in", moneyInLaunch: { tab: "document" } });
  });
});

describe("ribbon placement", () => {
  it("reveals horizontally beside the button on desktop", () => {
    const placement = computeRibbonPlacement({
      anchor: { top: 16, left: 1100, width: 96, height: 40 },
      ribbon: RIBBON,
      viewport: { width: 1280, height: 800 },
    });
    expect(placement.side).toBe("left");
    expect(placement.left + RIBBON.width).toBeLessThanOrEqual(1100);
  });

  it("opens to the right when there is no room on the left", () => {
    const placement = computeRibbonPlacement({
      anchor: { top: 16, left: 120, width: 96, height: 40 },
      ribbon: RIBBON,
      viewport: { width: 1024, height: 800 },
    });
    expect(placement.side).toBe("right");
  });

  it.each([375, 390, 430])("drops below the button without overflowing a %ipx phone", (width) => {
    const anchor = { top: 12, left: width - 104, width: 92, height: 40 };
    const placement = computeRibbonPlacement({ anchor, ribbon: RIBBON, viewport: { width, height: 800 } });
    expect(placement.side).toBe("below");
    expect(placement.top).toBeGreaterThanOrEqual(anchor.top + anchor.height);
    expect(placement.left).toBeGreaterThanOrEqual(8);
    expect(placement.left + Math.min(RIBBON.width, placement.maxWidth ?? Infinity)).toBeLessThanOrEqual(width - 8);
  });

  it("shrinks inside a viewport narrower than the ribbon", () => {
    const placement = computeRibbonPlacement({
      anchor: { top: 12, left: 150, width: 80, height: 40 },
      ribbon: { width: 400, height: 52 },
      viewport: { width: 320, height: 640 },
    });
    expect(placement.maxWidth).toBe(304);
    expect(placement.left).toBe(8);
  });
});

describe("closing and keyboard", () => {
  const node = (name: string) => ({ name }) as unknown as Node;
  const container = (...children: Node[]) => ({ contains: (n: Node | null) => children.includes(n as Node) });

  it("closes on an outside click but not on the trigger or ribbon", () => {
    const button = node("button");
    const item = node("item");
    const trigger = container(button);
    const ribbon = container(item);
    expect(isOutsideRibbon(node("page"), trigger, ribbon)).toBe(true);
    expect(isOutsideRibbon(button, trigger, ribbon)).toBe(false);
    expect(isOutsideRibbon(item, trigger, ribbon)).toBe(false);
  });

  it("closes on Escape and returns focus to + New", () => {
    expect(ribbonKeyAction("Escape", 0, 2)).toEqual({ type: "close", restoreFocus: true });
  });

  it("moves focus between options with arrow keys", () => {
    expect(ribbonKeyAction("ArrowRight", 0, 2)).toEqual({ type: "focus", index: 1 });
    expect(ribbonKeyAction("ArrowRight", 1, 2)).toEqual({ type: "focus", index: 0 });
    expect(ribbonKeyAction("ArrowLeft", 0, 2)).toEqual({ type: "focus", index: 1 });
    expect(ribbonKeyAction("End", 0, 2)).toEqual({ type: "focus", index: 1 });
    expect(ribbonKeyAction("a", 0, 2)).toBeNull();
  });
});
