/**
 * The header "+ New" control: which entry flows it offers, where its floating
 * ribbon sits, and how the keyboard moves through it. Kept free of React so
 * the behaviour is unit-testable.
 */

export type NewEntryKind = "expense" | "money_in";

export type NewEntryOption = {
  kind: NewEntryKind;
  label: string;
  /** Screen-reader hint for the direction of money. */
  hint: string;
};

export const NEW_ENTRY_OPTIONS: readonly NewEntryOption[] = [
  { kind: "expense", label: "Expense", hint: "Log money the department spent" },
  { kind: "money_in", label: "Money In", hint: "Record money the department received" },
];

export type NewEntryTarget =
  | { view: "new_expense"; expenseLaunch: { tab: "receipt" } }
  | { view: "new_money_in"; moneyInLaunch: { tab: "document" } };

/** Expense opens the existing receipt-first expense flow, unchanged. */
export function newEntryTarget(kind: NewEntryKind): NewEntryTarget {
  if (kind === "money_in") return { view: "new_money_in", moneyInLaunch: { tab: "document" } };
  return { view: "new_expense", expenseLaunch: { tab: "receipt" } };
}

export type Rect = { top: number; left: number; width: number; height: number };
export type Size = { width: number; height: number };

export type RibbonPlacement = {
  side: "left" | "right" | "below";
  top: number;
  left: number;
  /** Set when the ribbon has to shrink to stay inside a very narrow viewport. */
  maxWidth: number | null;
};

/** Phones always open the ribbon below the button. */
export const RIBBON_STACK_BREAKPOINT = 640;

/**
 * Desktop reveals the ribbon horizontally beside "+ New" (into the search
 * area first, then to the right). Phones, or any viewport without room
 * beside the button, drop it just below. The result never overflows the
 * viewport.
 */
export function computeRibbonPlacement(params: {
  anchor: Rect;
  ribbon: Size;
  viewport: Size;
  gap?: number;
  margin?: number;
}): RibbonPlacement {
  const { anchor, ribbon, viewport } = params;
  const gap = params.gap ?? 8;
  const margin = params.margin ?? 8;
  const anchorRight = anchor.left + anchor.width;
  const centeredTop = clamp(
    anchor.top + (anchor.height - ribbon.height) / 2,
    margin,
    Math.max(margin, viewport.height - margin - ribbon.height),
  );

  if (viewport.width > RIBBON_STACK_BREAKPOINT) {
    const leftOfAnchor = anchor.left - gap - ribbon.width;
    if (leftOfAnchor >= margin) {
      return { side: "left", top: centeredTop, left: leftOfAnchor, maxWidth: null };
    }
    const rightOfAnchor = anchorRight + gap;
    if (rightOfAnchor + ribbon.width <= viewport.width - margin) {
      return { side: "right", top: centeredTop, left: rightOfAnchor, maxWidth: null };
    }
  }

  const available = viewport.width - margin * 2;
  const width = Math.min(ribbon.width, available);
  const left = clamp(anchorRight - width, margin, viewport.width - margin - width);
  return {
    side: "below",
    top: anchor.top + anchor.height + gap,
    left,
    maxWidth: ribbon.width > available ? available : null,
  };
}

export type RibbonKeyResult = { type: "focus"; index: number } | { type: "close"; restoreFocus: boolean } | null;

/** Roving focus inside the ribbon: arrows/Home/End move, Escape/Tab close. */
export function ribbonKeyAction(key: string, index: number, count: number): RibbonKeyResult {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return { type: "focus", index: (index + 1) % count };
    case "ArrowLeft":
    case "ArrowUp":
      return { type: "focus", index: (index - 1 + count) % count };
    case "Home":
      return { type: "focus", index: 0 };
    case "End":
      return { type: "focus", index: count - 1 };
    case "Escape":
      return { type: "close", restoreFocus: true };
    case "Tab":
      return { type: "close", restoreFocus: false };
    default:
      return null;
  }
}

/** Outside-click rule: anything that is not the trigger or the ribbon closes it. */
export function isOutsideRibbon(
  target: Node | null,
  trigger: { contains(node: Node | null): boolean } | null,
  ribbon: { contains(node: Node | null): boolean } | null,
): boolean {
  if (!target) return true;
  if (trigger?.contains(target)) return false;
  if (ribbon?.contains(target)) return false;
  return true;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
