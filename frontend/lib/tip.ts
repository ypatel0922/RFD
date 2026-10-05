/**
 * Tip (gratuity) support for receipt expenses.
 *
 * Restaurant and car-service receipts are usually photographed before the
 * handwritten tip clears the card, so Hallix separates the money on a receipt
 * into distinct concepts:
 *
 *   subtotal — the pre-tax cost of the items
 *   tax      — sales tax, which is NOT a tip
 *   base     — the printed pre-tip receipt total, i.e. subtotal + tax
 *   tip      — the gratuity, handwritten or printed
 *   total    — base + tip, which is what actually hits the bank account
 *
 * Tax is the trap here. On a receipt reading 85.00 / 5.95 / 90.95, the gap
 * between the subtotal and the total is sales tax, not a $5.95 tip. Tax is
 * therefore always resolved into the pre-tip total before any tip is derived.
 *
 * All arithmetic is in integer cents. Money never touches a float here.
 */

export type ReceiptAmounts = {
  /** Pre-tax subtotal, when the receipt prints one. */
  subtotalCents: number | null;
  /** Sales tax, when the receipt prints one. */
  taxCents: number | null;
  /** Printed pre-tip receipt total — already includes tax. */
  baseCents: number;
  tipCents: number | null;
  totalCents: number;
  /** How the tip was established, for the subtle UI indicator. */
  tipSource: "extracted" | "derived" | null;
};

/** Parse a money string or number into integer cents. Returns null when unusable. */
export function moneyToCents(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value * 100) : null;
  }
  const cleaned = value.replace(/[$,\s]/g, "").trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

/** Render integer cents as the decimal string the expense form stores. */
export function centsToMoneyString(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents) || cents <= 0) return "";
  return (cents / 100).toFixed(2);
}

/** total = base + tip. A missing tip simply means the total is the base. */
export function addTip(baseCents: number | null, tipCents: number | null): number {
  const base = baseCents && baseCents > 0 ? baseCents : 0;
  const tip = tipCents && tipCents > 0 ? tipCents : 0;
  return base + tip;
}

/**
 * A derived tip is only trustworthy when the gap between a confidently read
 * handwritten total and the printed base is plausible. Anything beyond this is
 * more likely a misread digit than a real gratuity.
 */
const MAX_DERIVED_TIP_RATIO = 1;

/** Cent-level slack when comparing two amounts that should be equal. */
const AMOUNT_MATCH_TOLERANCE_CENTS = 2;

/**
 * Establish the printed pre-tip receipt total, the figure a tip is measured
 * against. Getting this wrong is what turns sales tax into a phantom tip.
 *
 * `confident` is false only when the reading is genuinely ambiguous, in which
 * case the caller must not derive a tip from arithmetic.
 */
function resolvePreTipTotal(input: {
  subtotal: number | null;
  tax: number | null;
  base: number | null;
  total: number | null;
}): { preTip: number | null; confident: boolean } {
  const { subtotal, tax, base, total } = input;
  const hasTax = tax != null && tax > 0;

  if (base != null) {
    // Without tax there is nothing to confuse the printed total with.
    if (!hasTax) return { preTip: base, confident: true };

    // The extractor sometimes reports the pre-tax subtotal as the receipt
    // total. Two readings prove that happened, and both mean the tax belongs
    // inside the pre-tip total rather than on a tip line.
    const matchesSubtotal = subtotal != null && base === subtotal;
    const taxClosesTheGap =
      subtotal == null &&
      total != null &&
      Math.abs(base + tax - total) <= AMOUNT_MATCH_TOLERANCE_CENTS;
    if (matchesSubtotal || taxClosesTheGap) {
      return { preTip: base + tax, confident: true };
    }

    // A base distinct from a known subtotal is the real pre-tip total.
    if (subtotal != null) return { preTip: base, confident: true };

    // Taxed receipt with no subtotal to cross-check: we cannot tell whether
    // base already includes the tax, so no tip may be inferred from it.
    return { preTip: base, confident: false };
  }

  if (subtotal != null && hasTax) return { preTip: subtotal + tax, confident: true };
  // Any gap between a subtotal and the total is far more likely tax than tip.
  if (total != null) return { preTip: total, confident: true };
  if (subtotal != null) return { preTip: subtotal, confident: true };
  return { preTip: null, confident: false };
}

/**
 * Work out subtotal / tax / base / tip / total from whatever the extractor read.
 *
 * Tax is resolved first, so a tip is only ever measured against the printed
 * pre-tip total — never against the pre-tax subtotal. A tip is populated only
 * from real evidence: an explicit tip line, or a handwritten total that exceeds
 * a confidently known pre-tip total. Anything ambiguous yields `tipCents: null`,
 * because a missed tip is far safer than an invented one.
 */
export function reconcileReceiptAmounts(input: {
  /** Pre-tax subtotal, when the receipt prints one. */
  subtotalCents?: number | null;
  /** Sales tax, when the receipt prints one. */
  taxCents?: number | null;
  /** Printed pre-tip receipt total (subtotal + tax). */
  baseCents?: number | null;
  /** Tip read directly off an explicit tip or gratuity line. */
  tipCents?: number | null;
  /** Final total read off the receipt, possibly handwritten. */
  totalCents?: number | null;
}): ReceiptAmounts {
  const positive = (value: number | null | undefined) =>
    value != null && value > 0 ? value : null;
  const subtotal = positive(input.subtotalCents);
  const tax = positive(input.taxCents);
  const base = positive(input.baseCents);
  const tip = positive(input.tipCents);
  const total = positive(input.totalCents);

  const { preTip, confident } = resolvePreTipTotal({ subtotal, tax, base, total });
  const empty = { subtotalCents: subtotal, taxCents: tax };

  if (preTip == null) {
    return { ...empty, baseCents: 0, tipCents: null, totalCents: 0, tipSource: null };
  }

  // An explicit tip line is direct evidence and is always honoured.
  if (tip != null) {
    // A legible handwritten total outranks our arithmetic, and also repairs a
    // pre-tip total that was read as the subtotal.
    if (total != null && total - tip > 0) {
      return {
        ...empty,
        baseCents: total - tip,
        tipCents: tip,
        totalCents: total,
        tipSource: "extracted",
      };
    }
    return {
      ...empty,
      baseCents: preTip,
      tipCents: tip,
      totalCents: preTip + tip,
      tipSource: "extracted",
    };
  }

  // No tip line, and the total is at or below the pre-tip figure: nothing to
  // explain, so there is no tip.
  if (total == null || total - preTip <= AMOUNT_MATCH_TOLERANCE_CENTS) {
    return { ...empty, baseCents: preTip, tipCents: null, totalCents: preTip, tipSource: null };
  }

  // The total sits above the pre-tip figure. That gap is only a tip when the
  // pre-tip total is known for certain — otherwise it may still be tax.
  const difference = total - preTip;
  if (confident && difference <= preTip * MAX_DERIVED_TIP_RATIO) {
    return { ...empty, baseCents: preTip, tipCents: difference, totalCents: total, tipSource: "derived" };
  }
  if (!confident) {
    // Unresolved gap: bank the printed total as the amount paid, tip blank.
    return { ...empty, baseCents: total, tipCents: null, totalCents: total, tipSource: null };
  }
  // A gap too large to be a tip is a misread; trust the pre-tip total.
  return { ...empty, baseCents: preTip, tipCents: null, totalCents: preTip, tipSource: null };
}

/** Category and merchant words that normally involve a gratuity. */
const TIP_LIKELY_PATTERNS = [
  /\b(restaurant|dining|diner|bistro|grill|kitchen|eatery|steakhouse|pizzeria|cantina)\b/i,
  /\b(food|meal|meals|lunch|dinner|breakfast|brunch|catering|refreshment)\b/i,
  /\b(bar|pub|tavern|brewery|lounge)\b/i,
  /\b(cafe|caf\u00e9|coffee|espresso|bakery|deli)\b/i,
  /\b(taxi|cab|rideshare|uber|lyft|limo|livery|car\s*service|shuttle)\b/i,
  /\b(delivery|doordash|grubhub|postmates|seamless|courier)\b/i,
  /\b(valet|parking\s*attendant|bellhop|porter)\b/i,
  /\b(salon|barber|spa|stylist|haircut)\b/i,
  /\b(gratuity|tip|server|waitstaff|banquet)\b/i,
];

/**
 * Whether to surface the Tip control prominently.
 *
 * Driven by category and merchant context rather than a vendor allowlist, so a
 * department's own naming still works.
 */
export function isTipLikely(input: {
  category?: string | null;
  vendor?: string | null;
  description?: string | null;
  lineItems?: string[] | null;
  plaidCategory?: string | null;
  plaidMerchant?: string | null;
}): boolean {
  const haystack = [
    input.category,
    input.vendor,
    input.description,
    input.plaidCategory,
    input.plaidMerchant,
    ...(input.lineItems || []),
  ]
    .filter(Boolean)
    .join(" ");
  if (!haystack.trim()) return false;
  return TIP_LIKELY_PATTERNS.some((pattern) => pattern.test(haystack));
}

export type LinkedAmountResolution = {
  /** The amount to treat as the expense total. */
  totalCents: number;
  /** True when the linked charge already contains the tip. */
  linkedIncludesTip: boolean;
  /** True when the linked charge looks like a pre-tip authorization. */
  pendingPreTip: boolean;
};

/** Tolerance for matching a posted card amount to our computed total. */
const LINKED_MATCH_TOLERANCE_CENTS = 2;

/**
 * Decide what a linked card transaction means for an expense that carries a tip.
 *
 * A restaurant charge posts as base + tip, so when the linked amount already
 * equals our computed total we must use it as-is rather than adding the tip a
 * second time. A pending authorization that still equals the bare base is the
 * normal pre-tip state, not a mismatch.
 *
 * This only interprets amounts — it does not change Plaid syncing or matching.
 */
export function resolveLinkedTransactionAmount(input: {
  baseCents: number;
  tipCents: number | null;
  linkedAmountCents: number | null;
  pending?: boolean;
}): LinkedAmountResolution {
  const { baseCents, tipCents, linkedAmountCents, pending = false } = input;
  const expectedTotal = addTip(baseCents, tipCents);

  if (linkedAmountCents == null) {
    return { totalCents: expectedTotal, linkedIncludesTip: false, pendingPreTip: false };
  }

  const linked = Math.abs(linkedAmountCents);

  // The posted charge already covers base + tip — never add the tip again.
  if (Math.abs(linked - expectedTotal) <= LINKED_MATCH_TOLERANCE_CENTS) {
    return { totalCents: expectedTotal, linkedIncludesTip: true, pendingPreTip: false };
  }

  // Authorization still shows the pre-tip amount; the final post will catch up.
  if (Math.abs(linked - baseCents) <= LINKED_MATCH_TOLERANCE_CENTS && (tipCents ?? 0) > 0) {
    return { totalCents: expectedTotal, linkedIncludesTip: false, pendingPreTip: true };
  }

  return { totalCents: expectedTotal, linkedIncludesTip: false, pendingPreTip: pending };
}

/**
 * Money columns for a manually entered expense.
 *
 * total_amount stays the single amount charged (tip included, negated for money
 * in). base_amount and tip_amount are only written when a tip exists, so an
 * expense without a tip saves exactly as it did before tips were supported.
 */
export function manualAmountPayload(input: {
  amountCents: number;
  tipCents: number;
  moneyIn: boolean;
}): { total_amount: number | null; base_amount: number | null; tip_amount: number | null } {
  const amount = Math.max(input.amountCents, 0);
  // A deposit has no gratuity.
  const tip = input.moneyIn ? 0 : Math.max(input.tipCents, 0);
  const total = addTip(amount, tip);
  const signedTotal = input.moneyIn ? -total : total;
  return {
    total_amount: amount > 0 ? signedTotal / 100 : null,
    base_amount: amount > 0 && tip > 0 ? amount / 100 : null,
    tip_amount: amount > 0 && tip > 0 ? tip / 100 : null,
  };
}

/** Flag a tip bigger than the receipt itself so the user can double-check it. */
export function isTipDisproportionate(baseCents: number, tipCents: number | null): boolean {
  if (!tipCents || tipCents <= 0 || baseCents <= 0) return false;
  return tipCents > baseCents;
}
