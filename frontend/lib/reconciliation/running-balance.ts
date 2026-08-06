/**
 * Running-balance continuity.
 *
 * When a statement prints a balance after each row, that column is an
 * independent check on every amount we read: balance(n) must equal
 * balance(n-1) + signedAmount(n). A single misread digit shows up here as a gap,
 * which pinpoints the bad row instead of just reporting a statement that is out
 * of balance overall.
 */

import { BALANCE_TOLERANCE_CENTS } from "./config";
import type { Cents } from "./money";
import type { ConsolidatedLine } from "./types";

export type RunningBalanceGap = {
  pageNumber: number;
  rowNumber: number;
  sequence: number;
  expectedCents: Cents;
  reportedCents: Cents;
  differenceCents: Cents;
};

/**
 * Walk the consolidated lines and report every point where the printed running
 * balance disagrees with the arithmetic.
 *
 * Rows without a printed balance are skipped but their amounts still accumulate,
 * so a statement that prints a balance only on some rows is still checked.
 */
export function findRunningBalanceGaps(
  lines: ConsolidatedLine[],
  beginningBalanceCents: Cents | null,
): RunningBalanceGap[] {
  const gaps: RunningBalanceGap[] = [];

  // Anchor on the beginning balance when we have it; otherwise start from the
  // first row that prints a balance and work forward from there.
  let anchor: Cents | null = beginningBalanceCents;
  let pendingCents = 0;

  for (const line of lines) {
    if (line.isPending) continue;

    if (line.signedAmountCents == null) {
      // An unreadable amount breaks the chain. Stop checking rather than
      // reporting every later row as a gap.
      return gaps;
    }

    pendingCents += line.signedAmountCents;

    if (line.runningBalanceCents == null) continue;

    if (anchor == null) {
      // First printed balance becomes the anchor; nothing to verify yet.
      anchor = line.runningBalanceCents;
      pendingCents = 0;
      continue;
    }

    const expected = anchor + pendingCents;
    const difference = line.runningBalanceCents - expected;
    if (Math.abs(difference) > BALANCE_TOLERANCE_CENTS) {
      gaps.push({
        pageNumber: line.pageNumber,
        rowNumber: line.rowNumber,
        sequence: line.sequence,
        expectedCents: expected,
        reportedCents: line.runningBalanceCents,
        differenceCents: difference,
      });
    }

    // Re-anchor on the printed value so one bad row does not cascade.
    anchor = line.runningBalanceCents;
    pendingCents = 0;
  }

  return gaps;
}
