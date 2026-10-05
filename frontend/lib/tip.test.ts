import { describe, expect, it } from "vitest";

import {
  addTip,
  centsToMoneyString,
  isTipDisproportionate,
  isTipLikely,
  manualAmountPayload,
  moneyToCents,
  reconcileReceiptAmounts,
  resolveLinkedTransactionAmount,
} from "./tip";

describe("money conversion", () => {
  it("parses strings, numbers, and currency formatting into cents", () => {
    expect(moneyToCents("90.95")).toBe(9095);
    expect(moneyToCents("$1,234.56")).toBe(123456);
    expect(moneyToCents(18)).toBe(1800);
    expect(moneyToCents("")).toBeNull();
    expect(moneyToCents("abc")).toBeNull();
    expect(moneyToCents(null)).toBeNull();
  });

  it("round-trips without floating point drift", () => {
    // 90.95 + 18.00 is the classic float trap: 108.94999999999999.
    const total = addTip(moneyToCents("90.95"), moneyToCents("18.00"));
    expect(total).toBe(10895);
    expect(centsToMoneyString(total)).toBe("108.95");
  });

  it("treats a missing tip as no tip", () => {
    expect(addTip(9095, null)).toBe(9095);
    expect(centsToMoneyString(null)).toBe("");
  });
});

describe("reconcileReceiptAmounts", () => {
  it("adds an explicitly read tip to the printed base", () => {
    expect(reconcileReceiptAmounts({ baseCents: 9095, tipCents: 1800 })).toMatchObject({
      baseCents: 9095,
      tipCents: 1800,
      totalCents: 10895,
      tipSource: "extracted",
    });
  });

  it("derives the tip from a handwritten total above the printed base", () => {
    expect(reconcileReceiptAmounts({ baseCents: 9095, totalCents: 10895 })).toMatchObject({
      baseCents: 9095,
      tipCents: 1800,
      totalCents: 10895,
      tipSource: "derived",
    });
  });

  it("reports no tip when the printed total equals the base", () => {
    const result = reconcileReceiptAmounts({ baseCents: 4250, totalCents: 4250 });
    expect(result.tipCents).toBeNull();
    expect(result.totalCents).toBe(4250);
  });

  it("refuses to derive an implausible tip from a likely misread", () => {
    // A $12 receipt cannot plausibly carry a $400 tip; trust the printed base.
    const result = reconcileReceiptAmounts({ baseCents: 1200, totalCents: 41200 });
    expect(result.tipCents).toBeNull();
    expect(result.totalCents).toBe(1200);
  });

  it("never produces a negative tip when the total is below the base", () => {
    const result = reconcileReceiptAmounts({ baseCents: 5000, totalCents: 4000 });
    expect(result.tipCents).toBeNull();
    expect(result.totalCents).toBe(5000);
  });

  it("back-fills the base when only a tip and total are legible", () => {
    expect(reconcileReceiptAmounts({ tipCents: 1000, totalCents: 6000 })).toMatchObject({
      baseCents: 5000,
      tipCents: 1000,
      totalCents: 6000,
      tipSource: "extracted",
    });
  });

  it("falls back to the total alone for a plain non-tipped receipt", () => {
    const result = reconcileReceiptAmounts({ totalCents: 3499 });
    expect(result).toMatchObject({
      baseCents: 3499,
      tipCents: null,
      totalCents: 3499,
      tipSource: null,
    });
  });

  it("returns zeroes when nothing was readable", () => {
    const result = reconcileReceiptAmounts({});
    expect(result.totalCents).toBe(0);
    expect(result.tipCents).toBeNull();
  });
});

describe("tax is never mistaken for a tip", () => {
  it("treats the subtotal-to-total gap as tax, not a tip", () => {
    // The Capo Restaurant bug: $5.95 of sales tax surfaced as a $5.95 tip.
    const result = reconcileReceiptAmounts({
      subtotalCents: 8500,
      taxCents: 595,
      baseCents: 9095,
      totalCents: 9095,
    });
    expect(result.tipCents).toBeNull();
    expect(result.tipSource).toBeNull();
    expect(result.baseCents).toBe(9095);
    expect(result.totalCents).toBe(9095);
    expect(result.taxCents).toBe(595);
  });

  it("recovers when the extractor reports the subtotal as the receipt total", () => {
    // base and subtotal agree, so the tax still belongs inside the pre-tip total.
    const result = reconcileReceiptAmounts({
      subtotalCents: 8500,
      taxCents: 595,
      baseCents: 8500,
      totalCents: 9095,
    });
    expect(result.tipCents).toBeNull();
    expect(result.baseCents).toBe(9095);
    expect(result.totalCents).toBe(9095);
  });

  it("recovers without a subtotal when the tax exactly closes the gap", () => {
    const result = reconcileReceiptAmounts({ taxCents: 595, baseCents: 8500, totalCents: 9095 });
    expect(result.tipCents).toBeNull();
    expect(result.baseCents).toBe(9095);
    expect(result.totalCents).toBe(9095);
  });

  it("measures a handwritten tip against the pre-tip total, not the subtotal", () => {
    const result = reconcileReceiptAmounts({
      subtotalCents: 8500,
      taxCents: 595,
      baseCents: 9095,
      tipCents: 1800,
      totalCents: 10895,
    });
    expect(result.tipCents).toBe(1800);
    expect(result.totalCents).toBe(10895);
    // The wrong answer would be 108.95 - 85.00.
    expect(result.tipCents).not.toBe(2395);
  });

  it("derives a tip from a handwritten total using the tax-inclusive pre-tip total", () => {
    const result = reconcileReceiptAmounts({
      subtotalCents: 8500,
      taxCents: 595,
      baseCents: 9095,
      totalCents: 10895,
    });
    expect(result.tipCents).toBe(1800);
    expect(result.tipSource).toBe("derived");
    expect(result.totalCents).toBe(10895);
  });

  it("repairs a subtotal-as-base reading when a handwritten tip is present", () => {
    const result = reconcileReceiptAmounts({
      taxCents: 595,
      baseCents: 8500,
      tipCents: 1800,
      totalCents: 10895,
    });
    expect(result.baseCents).toBe(9095);
    expect(result.tipCents).toBe(1800);
    expect(result.totalCents).toBe(10895);
  });

  it("leaves the tip blank when tax makes the pre-tip total ambiguous", () => {
    // Tax is present but there is no subtotal to confirm what base means, so
    // the gap cannot be safely attributed to a tip.
    const result = reconcileReceiptAmounts({ taxCents: 595, baseCents: 8500, totalCents: 10895 });
    expect(result.tipCents).toBeNull();
    expect(result.totalCents).toBe(10895);
  });

  it("builds the pre-tip total from subtotal and tax when no total is printed", () => {
    const result = reconcileReceiptAmounts({ subtotalCents: 8500, taxCents: 595 });
    expect(result.baseCents).toBe(9095);
    expect(result.tipCents).toBeNull();
    expect(result.totalCents).toBe(9095);
  });

  it("never infers a tip from a subtotal and total alone", () => {
    const result = reconcileReceiptAmounts({ subtotalCents: 8500, totalCents: 9095 });
    expect(result.tipCents).toBeNull();
    expect(result.totalCents).toBe(9095);
  });

  it("lets the user add a tip by hand after a tax-only extraction", () => {
    const extracted = reconcileReceiptAmounts({
      subtotalCents: 8500,
      taxCents: 595,
      baseCents: 9095,
      totalCents: 9095,
    });
    expect(extracted.tipCents).toBeNull();

    // The review screen adds a typed tip on top of the tax-inclusive amount.
    const typedTip = moneyToCents("18.00");
    expect(addTip(extracted.baseCents, typedTip)).toBe(10895);
  });
});

describe("isTipLikely", () => {
  it("flags tipped-service context from the category", () => {
    expect(isTipLikely({ category: "Food & Refreshments" })).toBe(true);
    expect(isTipLikely({ category: "Meals" })).toBe(true);
  });

  it("flags tipped-service context from merchant wording", () => {
    expect(isTipLikely({ vendor: "Lakeside Bar & Grill" })).toBe(true);
    expect(isTipLikely({ vendor: "Metro Car Service" })).toBe(true);
    expect(isTipLikely({ plaidMerchant: "UBER TRIP" })).toBe(true);
  });

  it("does not flag ordinary non-tipped purchases", () => {
    expect(isTipLikely({ category: "Equipment", vendor: "Home Depot" })).toBe(false);
    expect(isTipLikely({ category: "Fuel", vendor: "Shell Station" })).toBe(false);
    expect(isTipLikely({})).toBe(false);
  });

  it("uses receipt line items as a signal", () => {
    expect(isTipLikely({ vendor: "Corner Spot", lineItems: ["Server gratuity line"] })).toBe(true);
  });
});

describe("resolveLinkedTransactionAmount", () => {
  it("does not add the tip twice when the posted charge already includes it", () => {
    const result = resolveLinkedTransactionAmount({
      baseCents: 9095,
      tipCents: 1800,
      linkedAmountCents: 10895,
    });
    expect(result.totalCents).toBe(10895);
    expect(result.linkedIncludesTip).toBe(true);
    // The $126.95 double-count must never happen.
    expect(result.totalCents).not.toBe(12695);
  });

  it("recognizes a pending authorization taken before the tip", () => {
    const result = resolveLinkedTransactionAmount({
      baseCents: 9095,
      tipCents: 1800,
      linkedAmountCents: 9095,
      pending: true,
    });
    expect(result.pendingPreTip).toBe(true);
    expect(result.totalCents).toBe(10895);
  });

  it("handles negative (outflow) linked amounts", () => {
    const result = resolveLinkedTransactionAmount({
      baseCents: 9095,
      tipCents: 1800,
      linkedAmountCents: -10895,
    });
    expect(result.linkedIncludesTip).toBe(true);
  });

  it("falls back to the computed total when nothing is linked", () => {
    const result = resolveLinkedTransactionAmount({
      baseCents: 9095,
      tipCents: 1800,
      linkedAmountCents: null,
    });
    expect(result.totalCents).toBe(10895);
    expect(result.linkedIncludesTip).toBe(false);
  });
});

describe("manualAmountPayload", () => {
  it("saves a tipless expense exactly as before", () => {
    expect(manualAmountPayload({ amountCents: 4250, tipCents: 0, moneyIn: false })).toEqual({
      total_amount: 42.5,
      base_amount: null,
      tip_amount: null,
    });
  });

  it("folds the tip into the total and keeps base and tip separate", () => {
    expect(manualAmountPayload({ amountCents: 9095, tipCents: 1800, moneyIn: false })).toEqual({
      total_amount: 108.95,
      base_amount: 90.95,
      tip_amount: 18,
    });
  });

  it("stores money in as a negative total with no tip", () => {
    expect(manualAmountPayload({ amountCents: 5000, tipCents: 900, moneyIn: true })).toEqual({
      total_amount: -50,
      base_amount: null,
      tip_amount: null,
    });
  });

  it("returns no amount when none was entered", () => {
    expect(manualAmountPayload({ amountCents: 0, tipCents: 500, moneyIn: false })).toEqual({
      total_amount: null,
      base_amount: null,
      tip_amount: null,
    });
  });
});

describe("isTipDisproportionate", () => {
  it("warns only when the tip exceeds the receipt amount", () => {
    expect(isTipDisproportionate(9095, 1800)).toBe(false);
    expect(isTipDisproportionate(1000, 5000)).toBe(true);
    expect(isTipDisproportionate(1000, null)).toBe(false);
    // A large but legitimate tip is allowed; there is no arbitrary cap.
    expect(isTipDisproportionate(10000, 10000)).toBe(false);
  });
});
